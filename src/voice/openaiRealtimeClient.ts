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

const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";
const OPENAI_REALTIME_DEFAULT_TRANSCRIPTION_MODEL = "gpt-4o-mini-transcribe";
const OPENAI_REALTIME_DEFAULT_SESSION_MODEL = "gpt-realtime";
const OPENAI_REALTIME_SUPPORTED_TRANSCRIPTION_MODELS = new Set([
  "whisper-1",
  "gpt-4o-mini-transcribe-2025-12-15",
  "gpt-4o-mini-transcribe",
  "gpt-4o-transcribe",
  "gpt-4o-transcribe-latest"
]);
const OPENAI_REALTIME_SUPPORTED_SESSION_MODELS = new Set([
  "gpt-realtime",
  "gpt-realtime-1.5",
  "gpt-realtime-mini",
  "gpt-4o-realtime-preview",
  "gpt-4o-mini-realtime-preview"
]);

const AUDIO_DELTA_TYPES = new Set([
  "response.output_audio.delta"
]);

const TRANSCRIPT_TYPES = new Set([
  "conversation.item.input_audio_transcription.delta",
  "conversation.item.input_audio_transcription.completed",
  "response.output_audio_transcript.delta",
  "response.output_audio_transcript.done",
  "response.output_text.delta",
  "response.output_text.done"
]);

export class OpenAiRealtimeClient extends EventEmitter {
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
  activeResponseId;
  activeResponseStatus;
  latestVideoFrame;
  audioBase64Buffer: Buffer | null;

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
    this.activeResponseId = null;
    this.activeResponseStatus = null;
    this.latestVideoFrame = null;
    this.audioBase64Buffer = null;
  }

  async connect({
    model = OPENAI_REALTIME_DEFAULT_SESSION_MODEL,
    voice = "",
    instructions = "",
    inputAudioFormat = "pcm16",
    outputAudioFormat = "pcm16",
    inputTranscriptionModel = OPENAI_REALTIME_DEFAULT_TRANSCRIPTION_MODEL,
    inputTranscriptionLanguage = "",
    inputTranscriptionPrompt = "",
    tools = [],
    toolChoice = "auto",
  } = {}) {
    if (!this.apiKey) {
      throw new Error("Missing OPENAI_API_KEY for OpenAI realtime voice runtime.");
    }

    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      return this.getState();
    }

    const resolvedModel = normalizeOpenAiRealtimeSessionModel(
      model,
      OPENAI_REALTIME_DEFAULT_SESSION_MODEL
    );
    const resolvedVoice = String(voice || "").trim();
    if (!resolvedVoice) {
      throw new Error("OpenAI realtime voice is required (configure voice.openaiRealtime.voice).");
    }
    const resolvedInputAudioFormat = normalizeOpenAiRealtimeAudioFormat(inputAudioFormat, "input");
    const resolvedOutputAudioFormat = normalizeOpenAiRealtimeAudioFormat(outputAudioFormat, "output");
    const resolvedInputTranscriptionModel =
      normalizeOpenAiRealtimeTranscriptionModel(
        inputTranscriptionModel,
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
    const resolvedToolChoice = normalizeRealtimeToolChoice(toolChoice);
    const resolvedTools = normalizeRealtimeTools(tools);
    const ws = await this.openSocket(this.buildRealtimeUrl(resolvedModel));
    markRealtimeConnected(this, ws);

    ws.on("message", (payload) => {
      this.lastEventAt = Date.now();
      this.handleIncoming(payload);
    });

    ws.on("error", (error) => {
      handleRealtimeSocketError(this, error, {
        logEvent: "openai_realtime_ws_error"
      });
    });

    ws.on("close", (code, reasonBuffer) => {
      handleRealtimeSocketClose(this, code, reasonBuffer, {
        logEvent: "openai_realtime_ws_closed",
        onClose: () => {
          this.clearActiveResponse();
        }
      });
    });

    this.sessionConfig = {
      model: resolvedModel,
      voice: resolvedVoice,
      instructions: String(instructions || ""),
      inputAudioFormat: resolvedInputAudioFormat,
      outputAudioFormat: resolvedOutputAudioFormat,
      inputTranscriptionModel: resolvedInputTranscriptionModel,
      inputTranscriptionLanguage: resolvedInputTranscriptionLanguage,
      inputTranscriptionPrompt: resolvedInputTranscriptionPrompt,
      tools: resolvedTools,
      toolChoice: resolvedToolChoice
    };
    this.latestVideoFrame = null;
    this.sendSessionUpdate();

    return this.getState();
  }

  buildRealtimeUrl(model) {
    const base = normalizeOpenAiBaseUrl(this.baseUrl);
    const url = new URL(base);
    url.protocol = url.protocol === "http:" ? "ws:" : "wss:";
    const basePath = url.pathname.replace(/\/+$/, "");
    url.pathname = `${basePath}/realtime`;
    url.searchParams.set("model", normalizeOpenAiRealtimeSessionModel(
      model,
      OPENAI_REALTIME_DEFAULT_SESSION_MODEL
    ));
    return url.toString();
  }

  async openSocket(url): Promise<WebSocket> {
    return await openRealtimeSocket({
      url,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`
      },
      timeoutMessage: "Timed out connecting to OpenAI realtime after 10000ms.",
      connectErrorPrefix: "OpenAI realtime connection failed"
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

    if (event.type === "session.created" || event.type === "session.updated") {
      this.sessionId = event.session?.id || this.sessionId;
      this.log("info", "openai_realtime_session_updated", { sessionId: this.sessionId });
      return;
    }

    if (event.type === "error") {
      const errorPayload = event.error && typeof event.error === "object" ? event.error : {};
      const message =
        event.error?.message || event.error?.code || event.message || "Unknown OpenAI realtime error";
      const code = errorPayload?.code ? String(errorPayload.code).trim().toLowerCase() : "";
      if (code === "conversation_already_has_active_response") {
        const match = String(message).match(/\bresp_[a-z0-9]+\b/i);
        if (match?.[0]) {
          this.setActiveResponse(match[0], "in_progress");
        }
      }
      this.lastError = String(message);
      const errorMetadata = {
        error: this.lastError,
        code: errorPayload?.code || null,
        type: event.type,
        param: errorPayload?.param || null,
        eventId: event.event_id || null,
        lastOutboundEventType: this.lastOutboundEventType || null,
        lastOutboundEvent: this.lastOutboundEvent || null,
        recentOutboundEvents: this.recentOutboundEvents.slice(-4)
      };
      this.log("warn", "openai_realtime_error_event", {
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

    if (event.type === "response.created") {
      const response = event.response && typeof event.response === "object" ? event.response : {};
      const responseId = response?.id || event.response_id || null;
      const status = response?.status || event.status || "in_progress";
      this.setActiveResponse(responseId, status);
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
      const response = event.response && typeof event.response === "object" ? event.response : {};
      const responseId = response?.id || event.response_id || null;
      const status = response?.status || event.status || "completed";
      this.finishActiveResponse(responseId, status);
      this.emit("response_done", event);
    }
  }

  appendInputAudioPcm(audioBuffer) {
    if (!audioBuffer || !audioBuffer.length) return;

    // Base64 encoding requires groups of 3 bytes to avoid `=` padding characters natively.
    // The OpenAI API requires PCM16 format, which means samples are 2 bytes each.
    // The Least Common Multiple of 3 (Base64) and 2 (PCM16) is 6 bytes.
    // Therefore, we must buffer audio bits to a multiple of 6 bytes.
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
        output_modalities: ["audio"]
      }
    });
  }

  cancelActiveResponse() {
    const active = this.isResponseInProgress();
    if (!active) return false;

    try {
      this.send({
        type: "response.cancel"
      });
    } catch (error) {
      this.log("warn", "openai_realtime_response_cancel_failed", {
        error: String(error?.message || error)
      });
      this.clearActiveResponse("cancelled");
      return false;
    }

    this.clearActiveResponse("cancelled");
    return true;
  }

  truncateConversationItem({
    itemId = "",
    contentIndex = 0,
    audioEndMs = 0
  } = {}) {
    const normalizedItemId = String(itemId || "").trim();
    if (!normalizedItemId) return false;
    const normalizedContentIndex = Math.max(0, Math.floor(Number(contentIndex) || 0));
    const normalizedAudioEndMs = Math.max(0, Math.floor(Number(audioEndMs) || 0));
    this.send({
      type: "conversation.item.truncate",
      item_id: normalizedItemId,
      content_index: normalizedContentIndex,
      audio_end_ms: normalizedAudioEndMs
    });
    return true;
  }

  appendInputVideoFrame({ mimeType = "image/jpeg", dataBase64 }) {
    const normalizedFrame = String(dataBase64 || "").trim();
    if (!normalizedFrame) return;
    this.latestVideoFrame = {
      mimeType: normalizeImageMimeType(mimeType),
      dataBase64: normalizedFrame,
      at: Date.now()
    };
  }

  requestVideoCommentary(promptText) {
    const prompt = String(promptText || "").trim();
    if (!prompt) return;
    const frame = this.latestVideoFrame;
    if (!frame?.dataBase64) {
      throw new Error("No stream-watch frame buffered for OpenAI realtime commentary.");
    }
    const imageUrl = `data:${frame.mimeType};base64,${frame.dataBase64}`;
    this.send({
      type: "response.create",
      response: {
        conversation: "none",
        output_modalities: ["audio"],
        input: [
          {
            type: "message",
            role: "user",
            content: [
              {
                type: "input_text",
                text: prompt
              },
              {
                type: "input_image",
                image_url: imageUrl
              }
            ]
          }
        ]
      }
    });
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

  sendFunctionCallOutput({
    callId = "",
    output = ""
  } = {}) {
    const normalizedCallId = String(callId || "").trim();
    if (!normalizedCallId) {
      throw new Error("OpenAI realtime function_call_output requires a callId.");
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

  updateInstructions(instructions = "") {
    if (!this.sessionConfig || typeof this.sessionConfig !== "object") {
      throw new Error("OpenAI realtime session config is not initialized.");
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
  } = {}) {
    if (!this.sessionConfig || typeof this.sessionConfig !== "object") {
      throw new Error("OpenAI realtime session config is not initialized.");
    }

    this.sessionConfig = {
      ...this.sessionConfig,
      tools: normalizeRealtimeTools(tools),
      toolChoice: normalizeRealtimeToolChoice(toolChoice)
    };
    this.sendSessionUpdate();
  }

  send(payload) {
    sendRealtimePayload(this, {
      payload,
      eventType: String(payload?.type || "unknown"),
      summarizeOutboundPayload,
      skipHistoryEventType: "input_audio_buffer.append",
      skipLogEventType: "input_audio_buffer.append",
      logEvent: "openai_realtime_client_event_sent",
      socketNotOpenMessage: "OpenAI realtime socket is not open."
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
    this.latestVideoFrame = null;
    this.clearActiveResponse();
  }

  getState() {
    return {
      ...buildCommonRealtimeState(this),
      activeResponseId: this.activeResponseId || null,
      activeResponseStatus: this.activeResponseStatus || null,
      bufferedVideoFrameAt: this.latestVideoFrame?.at ? new Date(this.latestVideoFrame.at).toISOString() : null
    };
  }

  isResponseInProgress() {
    const status = String(this.activeResponseStatus || "")
      .trim()
      .toLowerCase();
    if (TERMINAL_RESPONSE_STATUSES.has(status)) return false;
    if (status === "in_progress") return true;
    return Boolean(this.activeResponseId);
  }

  log(level, event, metadata = null) {
    if (!this.logger) return;
    this.logger({ level, event, metadata });
  }

  sendSessionUpdate() {
    const session = this.sessionConfig && typeof this.sessionConfig === "object" ? this.sessionConfig : {};
    const resolvedVoice = String(session.voice || "").trim();
    if (!resolvedVoice) {
      throw new Error("OpenAI realtime voice is required (configure voice.openaiRealtime.voice).");
    }
    const normalizedTools = normalizeRealtimeTools(session.tools);
    const sessionPayload: Record<string, unknown> = compactObject({
      type: "realtime",
      model: String(session.model || OPENAI_REALTIME_DEFAULT_SESSION_MODEL).trim() || OPENAI_REALTIME_DEFAULT_SESSION_MODEL,
      output_modalities: ["audio"],
      instructions: String(session.instructions || ""),
      audio: compactObject({
        input: compactObject({
          format: {
            type: "audio/pcm",
            rate: 24000
          },
          turn_detection: null,
          transcription: compactObject({
            model:
              normalizeOpenAiRealtimeTranscriptionModel(
                session.inputTranscriptionModel,
                OPENAI_REALTIME_DEFAULT_TRANSCRIPTION_MODEL
              ),
            language: String(session.inputTranscriptionLanguage || "").trim() || null,
            prompt: String(session.inputTranscriptionPrompt || "").trim() || null
          })
        }),
        output: compactObject({
          format: normalizeOpenAiRealtimeAudioFormat(session.outputAudioFormat, "output"),
          voice: resolvedVoice
        })
      }),
      tools: normalizedTools.length ? normalizedTools : undefined,
      tool_choice: normalizedTools.length ? normalizeRealtimeToolChoice(session.toolChoice) : undefined
    });
    this.send({
      type: "session.update",
      session: sessionPayload
    });
  }

  setActiveResponse(responseId, status = "in_progress") {
    const normalizedId = responseId ? String(responseId).trim() : "";
    const normalizedStatus = String(status || "in_progress").trim() || "in_progress";
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

function normalizeOpenAiBaseUrl(value) {
  const raw = String(value || DEFAULT_OPENAI_BASE_URL).trim();
  const normalized = raw || DEFAULT_OPENAI_BASE_URL;
  return normalized.replace(/\/+$/, "");
}

function normalizeOpenAiRealtimeTranscriptionModel(value, fallback = OPENAI_REALTIME_DEFAULT_TRANSCRIPTION_MODEL) {
  const normalized = String(value || "").trim() || String(fallback || "").trim() || OPENAI_REALTIME_DEFAULT_TRANSCRIPTION_MODEL;
  if (OPENAI_REALTIME_SUPPORTED_TRANSCRIPTION_MODELS.has(normalized)) return normalized;
  return OPENAI_REALTIME_DEFAULT_TRANSCRIPTION_MODEL;
}

function normalizeOpenAiRealtimeSessionModel(value, fallback = OPENAI_REALTIME_DEFAULT_SESSION_MODEL) {
  const normalized =
    String(value || "").trim() || String(fallback || "").trim() || OPENAI_REALTIME_DEFAULT_SESSION_MODEL;
  return OPENAI_REALTIME_SUPPORTED_SESSION_MODELS.has(normalized)
    ? normalized
    : OPENAI_REALTIME_DEFAULT_SESSION_MODEL;
}

function normalizeOpenAiRealtimeAudioFormat(value, direction = "input") {
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
  if (normalized === "audio/pcm") {
    return {
      type: "audio/pcm",
      rate: 24000
    };
  }

  // GA Realtime uses explicit media-type descriptors for PCM.
  // Keep the direction arg in case we need asymmetric defaults later.
  void direction;
  return {
    type: "audio/pcm",
    rate: 24000
  };
}

function normalizeImageMimeType(value) {
  const normalized = String(value || "image/jpeg")
    .trim()
    .toLowerCase();
  if (normalized === "image/jpg") return "image/jpeg";
  if (normalized === "image/png") return "image/png";
  if (normalized === "image/webp") return "image/webp";
  return "image/jpeg";
}

function normalizeRealtimeTools(value) {
  if (!Array.isArray(value)) return [];
  const normalized = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const name = String(entry.name || "").trim().slice(0, 120);
    if (!name) continue;
    const type = String(entry.type || "function")
      .trim()
      .toLowerCase();
    if (type !== "function") continue;
    const sourceParameters =
      entry.parameters && typeof entry.parameters === "object" && !Array.isArray(entry.parameters)
        ? { ...entry.parameters }
        : null;
    let normalizedParameters = sourceParameters;
    if (!normalizedParameters) {
      normalizedParameters = {
        type: "object",
        properties: {},
        additionalProperties: true
      };
    }

    if (!Object.hasOwn(normalizedParameters, "type")) {
      normalizedParameters = {
        ...normalizedParameters,
        type: "object"
      };
    }

    const normalizedType = String(normalizedParameters.type || "object")
      .trim()
      .toLowerCase();

    if (normalizedType === "object" && !Object.hasOwn(normalizedParameters, "properties")) {
      normalizedParameters = {
        ...normalizedParameters,
        properties: {}
      };
    }

    if (!Object.hasOwn(normalizedParameters, "additionalProperties")) {
      normalizedParameters = {
        ...normalizedParameters,
        additionalProperties: true
      };
    }
    normalized.push(compactObject({
      type: "function",
      name,
      description: String(entry.description || "").trim().slice(0, 800) || undefined,
      parameters: normalizedParameters
    }));
  }
  return normalized.slice(0, 64);
}

function normalizeRealtimeToolChoice(value) {
  const normalized = String(value || "auto")
    .trim()
    .toLowerCase();
  if (normalized === "required") return "required";
  if (normalized === "none") return "none";
  return "auto";
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

  if (type === "input_audio_buffer.commit") {
    const response = payload.response && typeof payload.response === "object" ? payload.response : null;
    return compactObject({
      type,
      response: response
        ? {
          outputModalities: Array.isArray(response.output_modalities)
            ? response.output_modalities.slice(0, 4)
            : null
        }
        : null
    });
  }

  if (type === "response.create") {
    const response = payload.response && typeof payload.response === "object" ? payload.response : null;
    const inputItems = Array.isArray(response?.input) ? response.input : [];
    const inputTextChars = inputItems.reduce((total, item) => {
      const content = Array.isArray(item?.content) ? item.content : [];
      return (
        total +
        content.reduce((sum, part) => {
          if (part?.type !== "input_text") return sum;
          return sum + String(part?.text || "").length;
        }, 0)
      );
    }, 0);
    const hasInputImage = inputItems.some((item) => {
      const content = Array.isArray(item?.content) ? item.content : [];
      return content.some((part) => part?.type === "input_image");
    });
    return compactObject({
      type,
      response: response
        ? {
          conversation: response.conversation || null,
          outputModalities: Array.isArray(response.output_modalities)
            ? response.output_modalities.slice(0, 4)
            : null,
          inputItems: inputItems.length,
          inputTextChars,
          hasInputImage
        }
        : null
    });
  }

  if (type === "conversation.item.create") {
    const item = payload.item && typeof payload.item === "object" ? payload.item : {};
    const itemType = String(item.type || "unknown").trim() || "unknown";
    if (itemType === "function_call_output") {
      return compactObject({
        type,
        itemType,
        callId: String(item.call_id || "").trim() || null,
        outputChars: String(item.output || "").length || 0
      });
    }
    if (itemType === "message") {
      const content = Array.isArray(item.content) ? item.content : [];
      const inputTextChars = content.reduce((sum, entry) => {
        if (!entry || typeof entry !== "object") return sum;
        if (String(entry.type || "").trim().toLowerCase() !== "input_text") return sum;
        return sum + String(entry.text || "").length;
      }, 0);
      return compactObject({
        type,
        itemType,
        role: String(item.role || "").trim() || null,
        inputTextChars
      });
    }
    return compactObject({
      type,
      itemType
    });
  }

  if (type === "conversation.item.truncate") {
    return compactObject({
      type,
      itemId: String(payload.item_id || "").trim() || null,
      contentIndex:
        Number.isFinite(Number(payload.content_index)) && Number(payload.content_index) >= 0
          ? Math.floor(Number(payload.content_index))
          : 0,
      audioEndMs:
        Number.isFinite(Number(payload.audio_end_ms)) && Number(payload.audio_end_ms) >= 0
          ? Math.floor(Number(payload.audio_end_ms))
          : 0
    });
  }

  if (type === "session.update") {
    const session = payload.session && typeof payload.session === "object" ? payload.session : {};
    const audio = session.audio && typeof session.audio === "object" ? session.audio : {};
    return compactObject({
      type,
      sessionType: session.type || null,
      model: session.model || null,
      inputAudioFormat: audio?.input?.format || null,
      outputAudioFormat: audio?.output?.format || null,
      outputVoice: audio?.output?.voice || null,
      inputTranscriptionModel: audio?.input?.transcription?.model || null,
      inputTranscriptionLanguage: audio?.input?.transcription?.language || null,
      inputTranscriptionPromptChars: audio?.input?.transcription?.prompt
        ? String(audio.input.transcription.prompt).length
        : 0,
      instructionsChars: session.instructions ? String(session.instructions).length : 0,
      toolCount: Array.isArray(session.tools) ? session.tools.length : 0,
      toolChoice: session.tool_choice || null,
    });
  }

  const preview = safeJsonPreview(payload);
  return compactObject({
    type,
    preview
  });
}
