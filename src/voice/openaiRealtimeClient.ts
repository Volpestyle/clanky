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
import {
  DEFAULT_OPENAI_BASE_URL,
  OPENAI_REALTIME_DEFAULT_SESSION_MODEL,
  OPENAI_REALTIME_DEFAULT_TRANSCRIPTION_MODEL,
  normalizeOpenAiRealtimeSessionModel,
  normalizeOpenAiBaseUrl,
  normalizeOpenAiRealtimeTranscriptionModel
} from "./realtimeProviderNormalization.ts";
import { normalizeInlineText } from "./voiceSessionHelpers.ts";

const COMMENTARY_RESPONSE_STALE_MS = 30_000;
const REPLY_ADDRESSING_SOURCE = "reply_addressing";
const PLAYBACK_RESPONSE_INSTRUCTIONS = [
  "You are rendering prewritten speech audio.",
  "Speak only the exact line requested by the user message.",
  "Do not answer, explain, refuse, or roleplay about the request.",
  "Do not add, remove, paraphrase, or substitute words.",
  "Treat punctuation only as prosody guidance.",
  "Return audio for the requested line and nothing else."
].join("\n");

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

type PendingReplyAddressingRequest = {
  correlationId: string;
  assistantText: string;
  speakerUserId: string | null;
  currentSpeakerName: string;
  requestId: number | null;
  responseSource: string | null;
  requestedAt: number;
  textBuffer: string;
  finalText: string;
};

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
  pendingCommentaryResponseId: string | null;
  pendingCommentaryRequestedAt: number;
  pendingReplyAddressingRequestsByCorrelationId: Map<string, PendingReplyAddressingRequest>;
  pendingReplyAddressingRequestsByResponseId: Map<string, PendingReplyAddressingRequest>;
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
    this.pendingCommentaryResponseId = null;
    this.pendingCommentaryRequestedAt = 0;
    this.pendingReplyAddressingRequestsByCorrelationId = new Map();
    this.pendingReplyAddressingRequestsByResponseId = new Map();
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
          this.pendingCommentaryResponseId = null;
          this.pendingCommentaryRequestedAt = 0;
          this.pendingReplyAddressingRequestsByCorrelationId.clear();
          this.pendingReplyAddressingRequestsByResponseId.clear();
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

    if (event.type === "session.created" || event.type === "session.updated") {
      this.emit("event", event);
      this.sessionId = event.session?.id || this.sessionId;
      this.log("info", "openai_realtime_session_updated", { sessionId: this.sessionId });
      return;
    }

    if (event.type === "error") {
      this.emit("event", event);
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

      if (isReplyAddressingResponseMetadata(response?.metadata)) {
        this.trackReplyAddressingResponseCreated({
          responseId,
          metadata: response?.metadata
        });
        return;
      }

      this.emit("event", event);
      if (response?.metadata?.source === "stream_watch_commentary") {
        this.pendingCommentaryResponseId = responseId || this.pendingCommentaryResponseId;
        return;
      }

      this.setActiveResponse(responseId, status);
      return;
    }

    if (AUDIO_DELTA_TYPES.has(event.type)) {
      this.emit("event", event);
      const audioBase64 = extractAudioBase64(event);
      if (audioBase64) {
        this.emit("audio_delta", audioBase64);
      }
      return;
    }

    if (TRANSCRIPT_TYPES.has(event.type)) {
      if (this.consumeReplyAddressingTranscriptEvent(event)) {
        return;
      }
      this.emit("event", event);
      const eventItem =
        event.item && typeof event.item === "object" ? (event.item as Record<string, unknown>) : null;
      const outputItem =
        event.output_item && typeof event.output_item === "object"
          ? (event.output_item as Record<string, unknown>)
          : null;
      const transcript =
        event.transcript ||
        event.text ||
        event.delta ||
        event?.item?.content?.[0]?.transcript ||
        null;
      const itemId =
        normalizeInlineText(event.item_id || eventItem?.id || outputItem?.id, 180) || null;
      const previousItemId =
        normalizeInlineText(
          event.previous_item_id ||
          event.previousItemId ||
          eventItem?.previous_item_id ||
          outputItem?.previous_item_id,
          180
        ) || null;

      if (transcript) {
        this.emit("transcript", {
          text: String(transcript),
          eventType: String(event.type || ""),
          itemId,
          previousItemId
        });
      }
      return;
    }

    if (event.type === "response.done") {
      const response = event.response && typeof event.response === "object" ? event.response : {};
      const responseId = response?.id || event.response_id || null;
      const status = response?.status || event.status || "completed";

      if (isReplyAddressingResponseMetadata(response?.metadata)) {
        this.finishReplyAddressingResponse({
          responseId,
          response,
          metadata: response?.metadata
        });
        return;
      }

      this.emit("event", event);
      if (response?.metadata?.source === "stream_watch_commentary") {
        this.pendingCommentaryResponseId = null;
        this.pendingCommentaryRequestedAt = 0;
        this.emit("response_done", event);
        return;
      }

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
    // Set a provisional active response before sending so that concurrent
    // callers see isResponseInProgress() === true immediately, closing the
    // TOCTOU window between the send and OpenAI's async response event.
    if (!this.activeResponseId) {
      this.setActiveResponse(`pending_${Date.now()}`, "in_progress");
    }
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

    if (this.pendingCommentaryResponseId) {
      const age = Date.now() - this.pendingCommentaryRequestedAt;
      if (age < COMMENTARY_RESPONSE_STALE_MS) return;
      this.pendingCommentaryResponseId = null;
      this.pendingCommentaryRequestedAt = 0;
    }

    this.pendingCommentaryResponseId = `pending_commentary_${Date.now()}`;
    this.pendingCommentaryRequestedAt = Date.now();

    const imageUrl = `data:${frame.mimeType};base64,${frame.dataBase64}`;
    this.send({
      type: "response.create",
      response: {
        conversation: "none",
        metadata: { source: "stream_watch_commentary" },
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

  requestReplyAddressingClassification({
    assistantText = "",
    currentSpeakerName = "",
    speakerUserId = null,
    requestId = null,
    responseSource = null,
    participants = [],
    botName = ""
  } = {}) {
    const normalizedAssistantText = String(assistantText || "").replace(/\s+/g, " ").trim().slice(0, 360);
    if (!normalizedAssistantText) return false;
    const normalizedSpeakerName = String(currentSpeakerName || "").replace(/\s+/g, " ").trim().slice(0, 80);
    const participantList = Array.isArray(participants)
      ? [...new Set(
        participants
          .map((entry) => String(entry || "").replace(/\s+/g, " ").trim().slice(0, 80))
          .filter(Boolean)
      )]
      : [];
    const correlationId = `reply_addressing_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    this.pendingReplyAddressingRequestsByCorrelationId.set(correlationId, {
      correlationId,
      assistantText: normalizedAssistantText,
      speakerUserId: String(speakerUserId || "").trim() || null,
      currentSpeakerName: normalizedSpeakerName,
      requestId: Number.isFinite(Number(requestId)) ? Math.max(0, Math.floor(Number(requestId))) : null,
      responseSource: String(responseSource || "").trim() || null,
      requestedAt: Date.now(),
      textBuffer: "",
      finalText: ""
    });

    const normalizedBotName = String(botName || "").replace(/\s+/g, " ").trim().slice(0, 80);
    const participantSummary = participantList.length ? participantList.join(" | ") : "none";
    const classificationInput = [
      normalizedBotName ? `Bot name: ${normalizedBotName}` : "",
      `Current speaker: ${normalizedSpeakerName || "unknown"}`,
      `Participants: ${participantSummary}`,
      "",
      "Just-finished assistant reply transcript:",
      normalizedAssistantText
    ]
      .filter(Boolean)
      .join("\n");

    this.send({
      type: "response.create",
      response: compactObject({
        conversation: "none",
        metadata: {
          source: REPLY_ADDRESSING_SOURCE,
          correlationId
        },
        output_modalities: ["text"],
        instructions: [
          "Classify who the assistant is addressing in the just-finished spoken reply.",
          "Return exactly one token and nothing else:",
          "- SPEAKER",
          "- ALL",
          "- one exact participant display name from the provided list",
          "- UNKNOWN",
          "Use SPEAKER when the assistant is replying to the current speaker.",
          "Use ALL only when the assistant is clearly addressing the whole room.",
          "Use a participant display name only when the assistant is clearly addressing someone other than the current speaker.",
          "Use UNKNOWN when the target is unclear or untargeted.",
          "Do not return punctuation, JSON, or explanation."
        ].join("\n"),
        tools: [],
        tool_choice: "none",
        input: [
          {
            type: "message",
            role: "user",
            content: [
              {
                type: "input_text",
                text: classificationInput
              }
            ]
          }
        ]
      })
    });
    return true;
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

  requestPlaybackUtterance(promptText) {
    const prompt = String(promptText || "").trim();
    if (!prompt) return;
    if (!this.activeResponseId) {
      this.setActiveResponse(`pending_${Date.now()}`, "in_progress");
    }
    this.send({
      type: "response.create",
      response: compactObject({
        conversation: "none",
        output_modalities: ["audio"],
        instructions: PLAYBACK_RESPONSE_INSTRUCTIONS,
        // Exact-line utterances are already generated upstream; disable tools so
        // the speech model cannot reinterpret them as new tool work.
        tools: [],
        tool_choice: "none",
        input: [
          {
            type: "message",
            role: "user",
            content: [
              {
                type: "input_text",
                text: prompt
              }
            ]
          }
        ]
      })
    });
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
    this.pendingCommentaryResponseId = null;
    this.pendingCommentaryRequestedAt = 0;
    this.pendingReplyAddressingRequestsByCorrelationId.clear();
    this.pendingReplyAddressingRequestsByResponseId.clear();
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

  isCommentaryResponsePending() {
    return Boolean(this.pendingCommentaryResponseId);
  }

  log(level, event, metadata = null) {
    if (!this.logger) return;
    this.logger({ level, event, metadata });
  }

  trackReplyAddressingResponseCreated({
    responseId = null,
    metadata = null
  }: {
    responseId?: string | null;
    metadata?: Record<string, unknown> | null;
  } = {}) {
    const normalizedResponseId = normalizeInlineText(responseId, 180) || null;
    const correlationId = normalizeInlineText(metadata?.correlationId, 180) || null;
    if (!normalizedResponseId || !correlationId) return false;
    const pending = this.pendingReplyAddressingRequestsByCorrelationId.get(correlationId) || null;
    if (!pending) return false;
    this.pendingReplyAddressingRequestsByCorrelationId.delete(correlationId);
    this.pendingReplyAddressingRequestsByResponseId.set(normalizedResponseId, pending);
    return true;
  }

  consumeReplyAddressingTranscriptEvent(event) {
    const eventType = String(event?.type || "").trim();
    if (!eventType.startsWith("response.output_text")) return false;
    const normalizedResponseId = extractRealtimeResponseId(event);
    let pending = normalizedResponseId
      ? this.pendingReplyAddressingRequestsByResponseId.get(normalizedResponseId) || null
      : null;
    if (!pending && !normalizedResponseId && this.pendingReplyAddressingRequestsByResponseId.size === 1) {
      pending = [...this.pendingReplyAddressingRequestsByResponseId.values()][0] || null;
    }
    if (!pending && !normalizedResponseId && this.pendingReplyAddressingRequestsByCorrelationId.size === 1) {
      pending = [...this.pendingReplyAddressingRequestsByCorrelationId.values()][0] || null;
    }
    if (!pending) return false;
    if (eventType === "response.output_text.done") {
      const finalText = String(event?.text || event?.transcript || "").trim();
      if (finalText) {
        pending.finalText = finalText.slice(0, 240);
      }
      return true;
    }
    const delta = typeof event?.delta === "string" ? event.delta : "";
    if (delta) {
      pending.textBuffer = `${String(pending.textBuffer || "")}${delta}`.slice(0, 240);
    }
    return true;
  }

  finishReplyAddressingResponse({
    responseId = null,
    response = null,
    metadata = null
  }: {
    responseId?: string | null;
    response?: Record<string, unknown> | null;
    metadata?: Record<string, unknown> | null;
  } = {}) {
    const normalizedResponseId = normalizeInlineText(responseId, 180) || null;
    const correlationId = normalizeInlineText(metadata?.correlationId, 180) || null;
    let pending = normalizedResponseId
      ? this.pendingReplyAddressingRequestsByResponseId.get(normalizedResponseId) || null
      : null;
    if (!pending && correlationId) {
      pending = this.pendingReplyAddressingRequestsByCorrelationId.get(correlationId) || null;
    }
    if (!pending) return false;
    if (normalizedResponseId) {
      this.pendingReplyAddressingRequestsByResponseId.delete(normalizedResponseId);
    }
    if (correlationId) {
      this.pendingReplyAddressingRequestsByCorrelationId.delete(correlationId);
    }
    const classifierText =
      extractResponseOutputText(response) ||
      String(pending.finalText || "").trim() ||
      String(pending.textBuffer || "").trim() ||
      "";
    this.emit("reply_addressing_result", {
      responseId: normalizedResponseId,
      correlationId: pending.correlationId,
      requestId: pending.requestId,
      responseSource: pending.responseSource,
      speakerUserId: pending.speakerUserId,
      currentSpeakerName: pending.currentSpeakerName,
      assistantText: pending.assistantText,
      classifierText
    });
    return true;
  }

  sendSessionUpdate() {
    const session = this.sessionConfig && typeof this.sessionConfig === "object" ? this.sessionConfig : {};
    const resolvedVoice = String(session.voice || "").trim();
    if (!resolvedVoice) {
      throw new Error("OpenAI realtime voice is required (configure voice.openaiRealtime.voice).");
    }
    const normalizedTools = normalizeRealtimeTools(session.tools);
    const inputAudio = {
      format: normalizeOpenAiRealtimeAudioFormat(session.inputAudioFormat, "input"),
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
    };
    const sessionPayload: Record<string, unknown> = compactObject({
      type: "realtime",
      model: String(session.model || OPENAI_REALTIME_DEFAULT_SESSION_MODEL).trim() || OPENAI_REALTIME_DEFAULT_SESSION_MODEL,
      output_modalities: ["audio"],
      instructions: String(session.instructions || ""),
      audio: compactObject({
        input: inputAudio,
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

function normalizeOpenAiRealtimeAudioFormat(value, direction = "input") {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const type = String(value.type || "")
      .trim()
      .toLowerCase();
    if (type === "audio/pcm" || type === "pcm16") {
      const rate = Number(value.rate);
      return {
        type: "audio/pcm",
        rate: Number.isFinite(rate) && rate > 0 ? Math.floor(rate) : 24000
      };
    }
    if (type === "audio/pcmu" || type === "g711_ulaw") {
      return { type: "audio/pcmu" };
    }
    if (type === "audio/pcma" || type === "g711_alaw") {
      return { type: "audio/pcma" };
    }
  }

  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  if (normalized === "audio/pcmu" || normalized === "g711_ulaw") return { type: "audio/pcmu" };
  if (normalized === "audio/pcma" || normalized === "g711_alaw") return { type: "audio/pcma" };

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
      outputModalities: Array.isArray(session.output_modalities) ? session.output_modalities : null,
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

function isReplyAddressingResponseMetadata(metadata: unknown) {
  return String((metadata as Record<string, unknown> | null)?.source || "").trim() === REPLY_ADDRESSING_SOURCE;
}

function extractRealtimeResponseId(event: Record<string, unknown> | null | undefined) {
  if (!event || typeof event !== "object") return null;
  const response =
    event.response && typeof event.response === "object" ? (event.response as Record<string, unknown>) : null;
  const eventItem =
    event.item && typeof event.item === "object" ? (event.item as Record<string, unknown>) : null;
  const outputItem =
    event.output_item && typeof event.output_item === "object"
      ? (event.output_item as Record<string, unknown>)
      : null;
  return normalizeInlineText(
    event.response_id || event.responseId || response?.id || eventItem?.response_id || outputItem?.response_id,
    180
  ) || null;
}

function extractResponseOutputText(response: Record<string, unknown> | null | undefined) {
  if (!response || typeof response !== "object") return "";
  const outputItems = Array.isArray(response.output) ? response.output : [];
  const fragments: string[] = [];
  for (const item of outputItems) {
    if (!item || typeof item !== "object") continue;
    if (
      String((item as Record<string, unknown>).type || "").trim().toLowerCase() === "output_text" &&
      typeof (item as Record<string, unknown>).text === "string"
    ) {
      fragments.push(String((item as Record<string, unknown>).text || ""));
    }
    const content = Array.isArray((item as Record<string, unknown>).content)
      ? ((item as Record<string, unknown>).content as unknown[])
      : [];
    for (const part of content) {
      if (!part || typeof part !== "object") continue;
      const normalizedType = String((part as Record<string, unknown>).type || "").trim().toLowerCase();
      if ((normalizedType === "output_text" || normalizedType === "text") && typeof (part as Record<string, unknown>).text === "string") {
        fragments.push(String((part as Record<string, unknown>).text || ""));
      }
    }
  }
  return fragments.join("").trim();
}
