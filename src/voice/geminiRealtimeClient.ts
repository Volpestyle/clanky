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
  safeJsonPreview,
  sendRealtimePayload
} from "./realtimeClientCore.ts";

const DEFAULT_GEMINI_BASE_URL = "https://generativelanguage.googleapis.com";
const GEMINI_LIVE_PATH = "/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";

export class GeminiRealtimeClient extends EventEmitter {
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
  setupComplete;
  pendingResponseActive;
  audioActivityOpen;
  audioBase64Buffer: Buffer | null;

  constructor({ apiKey, baseUrl = DEFAULT_GEMINI_BASE_URL, logger = null }) {
    super();
    this.apiKey = String(apiKey || "").trim();
    this.baseUrl = String(baseUrl || DEFAULT_GEMINI_BASE_URL).trim() || DEFAULT_GEMINI_BASE_URL;
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
    this.setupComplete = false;
    this.pendingResponseActive = false;
    this.audioActivityOpen = false;
  }

  async connect({
    model = "gemini-2.5-flash-native-audio-preview-12-2025",
    voice = "Aoede",
    instructions = "",
    inputSampleRateHz = 16000,
    outputSampleRateHz = 24000
  } = {}) {
    if (!this.apiKey) {
      throw new Error("Missing GOOGLE_API_KEY for Gemini realtime voice runtime.");
    }

    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      return this.getState();
    }

    const resolvedModel = ensureGeminiModelPrefix(String(model || "").trim() || "gemini-2.5-flash-native-audio-preview-12-2025");
    const resolvedVoice = String(voice || "Aoede").trim() || "Aoede";
    const resolvedInputRate = Math.max(8000, Math.min(48000, Number(inputSampleRateHz) || 16000));
    const resolvedOutputRate = Math.max(8000, Math.min(48000, Number(outputSampleRateHz) || 24000));
    const ws = await this.openSocket(this.buildRealtimeUrl());

    markRealtimeConnected(this, ws);
    this.setupComplete = false;
    this.pendingResponseActive = false;
    this.audioActivityOpen = false;
    this.audioBase64Buffer = null;

    ws.on("message", (payload) => {
      this.lastEventAt = Date.now();
      this.handleIncoming(payload);
    });

    ws.on("error", (error) => {
      handleRealtimeSocketError(this, error, {
        logEvent: "gemini_realtime_ws_error"
      });
    });

    ws.on("close", (code, reasonBuffer) => {
      handleRealtimeSocketClose(this, code, reasonBuffer, {
        logEvent: "gemini_realtime_ws_closed",
        onClose: () => {
          this.pendingResponseActive = false;
          this.audioActivityOpen = false;
        }
      });
    });

    this.sessionConfig = {
      model: resolvedModel,
      voice: resolvedVoice,
      instructions: String(instructions || ""),
      inputSampleRateHz: resolvedInputRate,
      outputSampleRateHz: resolvedOutputRate,
      inputAudioMimeType: `audio/pcm;rate=${resolvedInputRate}`,
      outputAudioMimeType: `audio/pcm;rate=${resolvedOutputRate}`
    };

    this.sendSetup();

    return this.getState();
  }

  buildRealtimeUrl() {
    const base = normalizeGeminiBaseUrl(this.baseUrl);
    const url = new URL(base);
    url.protocol = url.protocol === "http:" ? "ws:" : "wss:";
    url.pathname = GEMINI_LIVE_PATH;
    url.searchParams.set("key", this.apiKey);
    return url.toString();
  }

  async openSocket(url): Promise<WebSocket> {
    return await openRealtimeSocket({
      url,
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": this.apiKey
      },
      timeoutMessage: "Timed out connecting to Gemini Live API after 10000ms.",
      connectErrorPrefix: "Gemini Live API connection failed"
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

    if (event.setupComplete && typeof event.setupComplete === "object") {
      this.setupComplete = true;
      this.log("info", "gemini_realtime_setup_complete", {
        model: this.sessionConfig?.model || null
      });
      return;
    }

    if (event.error) {
      const message =
        event.error?.message ||
        event.error?.status ||
        event.error?.code ||
        event.message ||
        "Unknown Gemini realtime error";
      this.lastError = String(message);
      const errorMetadata = {
        error: this.lastError,
        code: event.error?.code || null,
        status: event.error?.status || null,
        lastOutboundEventType: this.lastOutboundEventType || null,
        lastOutboundEvent: this.lastOutboundEvent || null,
        recentOutboundEvents: this.recentOutboundEvents.slice(-4)
      };
      this.log("warn", "gemini_realtime_error_event", {
        ...errorMetadata
      });
      this.emit("error_event", {
        message: this.lastError,
        code: event.error?.code || null,
        param: null,
        event,
        lastOutboundEventType: this.lastOutboundEventType || null,
        lastOutboundEvent: this.lastOutboundEvent || null,
        recentOutboundEvents: this.recentOutboundEvents.slice(-4)
      });
      return;
    }

    const serverContent = event.serverContent && typeof event.serverContent === "object"
      ? event.serverContent
      : null;
    if (!serverContent) return;

    const modelTurn = serverContent.modelTurn && typeof serverContent.modelTurn === "object"
      ? serverContent.modelTurn
      : null;
    const parts = Array.isArray(modelTurn?.parts) ? modelTurn.parts : [];

    for (const part of parts) {
      const audioBase64 = part?.inlineData?.data;
      if (typeof audioBase64 === "string" && audioBase64.trim()) {
        this.emit("audio_delta", audioBase64.trim());
      }

      const text = part?.text;
      if (typeof text === "string" && text.trim()) {
        this.emit("transcript", {
          text: text.trim(),
          eventType: "server_content_text"
        });
      }
    }

    const inputTranscription = serverContent.inputTranscription?.text;
    if (typeof inputTranscription === "string" && inputTranscription.trim()) {
      this.emit("transcript", {
        text: inputTranscription.trim(),
        eventType: "input_audio_transcription"
      });
    }

    const outputTranscription = serverContent.outputTranscription?.text;
    if (typeof outputTranscription === "string" && outputTranscription.trim()) {
      this.emit("transcript", {
        text: outputTranscription.trim(),
        eventType: "output_audio_transcription"
      });
    }

    if (serverContent.turnComplete || serverContent.generationComplete || serverContent.interrupted) {
      this.pendingResponseActive = false;
      this.emit("response_done", {
        type: "response.done",
        response: {
          id: null,
          status: serverContent.interrupted ? "interrupted" : "completed"
        },
        serverContent
      });
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
    if (!this.audioActivityOpen) {
      this.sendRealtimeInput({
        activityStart: {}
      });
      this.audioActivityOpen = true;
    }
    this.sendRealtimeInput({
      mediaChunks: [
        {
          mimeType: String(this.sessionConfig?.inputAudioMimeType || "audio/pcm;rate=16000"),
          data: String(audioBase64)
        }
      ]
    });
  }

  appendInputVideoFrame({ mimeType = "image/jpeg", dataBase64 }) {
    const data = String(dataBase64 || "").trim();
    if (!data) return;

    this.sendRealtimeInput({
      mediaChunks: [
        {
          mimeType: String(mimeType || "image/jpeg").trim() || "image/jpeg",
          data
        }
      ]
    });
  }

  commitInputAudioBuffer() {
    if (!this.audioActivityOpen) return;
    this.sendRealtimeInput({
      activityEnd: {}
    });
    this.audioActivityOpen = false;
  }

  createAudioResponse() {
    this.pendingResponseActive = true;
  }

  cancelActiveResponse() {
    // Gemini Live currently relies on turn completion/interruption events.
    return false;
  }

  requestVideoCommentary(promptText) {
    const prompt = String(promptText || "").trim();
    if (!prompt) return;

    this.pendingResponseActive = true;
    this.send({
      clientContent: {
        turns: [
          {
            role: "user",
            parts: [
              {
                text: prompt
              }
            ]
          }
        ],
        turnComplete: true
      }
    });
  }

  requestTextUtterance(promptText) {
    const prompt = String(promptText || "").trim();
    if (!prompt) return;

    this.pendingResponseActive = true;
    this.send({
      clientContent: {
        turns: [
          {
            role: "user",
            parts: [
              {
                text: prompt
              }
            ]
          }
        ],
        turnComplete: true
      }
    });
  }

  sendRealtimeInput(payload = {}) {
    this.send({
      realtimeInput: payload
    });
  }

  // Gemini Live API does not support mid-session instruction updates over WS.
  // This stores the instructions locally so they're used on next reconnect/setup.
  updateInstructions(instructions = "") {
    if (!this.sessionConfig || typeof this.sessionConfig !== "object") {
      throw new Error("Gemini realtime session config is not initialized.");
    }

    this.sessionConfig = {
      ...this.sessionConfig,
      instructions: String(instructions || "")
    };
  }

  sendSetup() {
    const session = this.sessionConfig && typeof this.sessionConfig === "object" ? this.sessionConfig : {};
    this.send({
      setup: compactObject({
        model: ensureGeminiModelPrefix(String(session.model || "gemini-2.5-flash-native-audio-preview-12-2025")),
        generationConfig: {
          responseModalities: ["AUDIO"],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: {
                voiceName: String(session.voice || "Aoede")
              }
            }
          }
        },
        systemInstruction: {
          role: "system",
          parts: [
            {
              text: String(session.instructions || "")
            }
          ]
        },
        realtimeInputConfig: {
          automaticActivityDetection: {
            disabled: true
          }
        },
        inputAudioTranscription: {},
        outputAudioTranscription: {}
      })
    });
  }

  send(payload) {
    sendRealtimePayload(this, {
      payload,
      eventType: summarizeGeminiEventType(payload),
      summarizeOutboundPayload,
      skipHistoryEventType: "realtimeInput.mediaChunks",
      skipLogEventType: "realtimeInput.mediaChunks",
      logEvent: "gemini_realtime_client_event_sent",
      socketNotOpenMessage: "Gemini realtime socket is not open."
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
    this.pendingResponseActive = false;
    this.audioActivityOpen = false;
    this.audioBase64Buffer = null;
  }

  getState() {
    return {
      ...buildCommonRealtimeState(this),
      setupComplete: this.setupComplete,
      pendingResponseActive: this.pendingResponseActive
    };
  }

  isResponseInProgress() {
    return Boolean(this.pendingResponseActive);
  }

  log(level, event, metadata = null) {
    if (!this.logger) return;
    this.logger({ level, event, metadata });
  }
}

function summarizeGeminiEventType(payload) {
  if (!payload || typeof payload !== "object") return "unknown";
  if (payload.setup) return "setup";
  if (payload.clientContent) return "clientContent";
  if (payload.realtimeInput?.mediaChunks) return "realtimeInput.mediaChunks";
  if (payload.realtimeInput?.activityStart) return "realtimeInput.activityStart";
  if (payload.realtimeInput?.activityEnd) return "realtimeInput.activityEnd";
  if (payload.realtimeInput) return "realtimeInput";
  return "unknown";
}

function summarizeOutboundPayload(payload) {
  if (!payload || typeof payload !== "object") return null;
  const type = summarizeGeminiEventType(payload);

  if (type === "realtimeInput.mediaChunks") {
    const chunks = Array.isArray(payload?.realtimeInput?.mediaChunks)
      ? payload.realtimeInput.mediaChunks
      : [];
    const first = chunks[0] && typeof chunks[0] === "object" ? chunks[0] : null;
    return compactObject({
      type,
      chunkCount: chunks.length,
      mimeType: first?.mimeType || null,
      dataChars: typeof first?.data === "string" ? first.data.length : 0
    });
  }

  if (type === "setup") {
    const setup = payload.setup && typeof payload.setup === "object" ? payload.setup : {};
    return compactObject({
      type,
      model: setup.model || null,
      instructionsChars: Array.isArray(setup?.systemInstruction?.parts)
        ? setup.systemInstruction.parts
          .map((part) => (typeof part?.text === "string" ? part.text.length : 0))
          .reduce((sum, value) => sum + value, 0)
        : 0
    });
  }

  if (type === "clientContent") {
    const turns = Array.isArray(payload?.clientContent?.turns)
      ? payload.clientContent.turns
      : [];
    const firstPart = turns[0]?.parts?.[0];
    return compactObject({
      type,
      turnCount: turns.length,
      turnComplete: payload?.clientContent?.turnComplete === true,
      firstPartTextChars: typeof firstPart?.text === "string" ? firstPart.text.length : 0
    });
  }

  const preview = safeJsonPreview(payload);
  return compactObject({
    type,
    preview
  });
}

function normalizeGeminiBaseUrl(value) {
  const raw = String(value || DEFAULT_GEMINI_BASE_URL).trim();
  const fallback = DEFAULT_GEMINI_BASE_URL;
  if (!raw) return fallback;

  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return fallback;
    }
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return fallback;
  }
}

function ensureGeminiModelPrefix(model) {
  const normalized = String(model || "").trim();
  if (!normalized) return "models/gemini-2.5-flash-native-audio-preview-12-2025";
  if (normalized.startsWith("models/")) return normalized;
  return `models/${normalized}`;
}
