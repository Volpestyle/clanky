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

const DEFAULT_ELEVENLABS_BASE_URL = "https://api.elevenlabs.io";

export class ElevenLabsRealtimeClient extends EventEmitter {
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
  pendingInputAudioBase64;
  audioBase64Buffer: Buffer | null;

  constructor({ apiKey, baseUrl = DEFAULT_ELEVENLABS_BASE_URL, logger = null }) {
    super();
    this.apiKey = String(apiKey || "").trim();
    this.baseUrl = String(baseUrl || DEFAULT_ELEVENLABS_BASE_URL).trim() || DEFAULT_ELEVENLABS_BASE_URL;
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
    this.pendingInputAudioBase64 = [];
    this.audioBase64Buffer = null;
  }

  async connect({
    agentId = "",
    instructions = "",
    inputSampleRateHz = 16000,
    outputSampleRateHz = 16000
  } = {}) {
    if (!this.apiKey) {
      throw new Error("Missing ELEVENLABS_API_KEY for ElevenLabs realtime voice runtime.");
    }
    const resolvedAgentId = String(agentId || "").trim();
    if (!resolvedAgentId) {
      throw new Error("ElevenLabs realtime agent ID is required (configure voice.elevenLabsRealtime.agentId).");
    }

    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      return this.getState();
    }

    const resolvedInputSampleRateHz = Math.max(8000, Math.min(48000, Number(inputSampleRateHz) || 16000));
    const resolvedOutputSampleRateHz = Math.max(8000, Math.min(48000, Number(outputSampleRateHz) || 16000));
    const signedUrl = await this.fetchSignedUrl(resolvedAgentId);
    const ws = await this.openSocket(signedUrl);
    markRealtimeConnected(this, ws);
    this.pendingInputAudioBase64 = [];

    ws.on("message", (payload) => {
      this.lastEventAt = Date.now();
      this.handleIncoming(payload);
    });

    ws.on("error", (error) => {
      handleRealtimeSocketError(this, error, {
        logEvent: "elevenlabs_realtime_ws_error"
      });
    });

    ws.on("close", (code, reasonBuffer) => {
      handleRealtimeSocketClose(this, code, reasonBuffer, {
        logEvent: "elevenlabs_realtime_ws_closed"
      });
    });

    this.sessionConfig = {
      agentId: resolvedAgentId,
      instructions: String(instructions || "").trim(),
      inputSampleRateHz: resolvedInputSampleRateHz,
      outputSampleRateHz: resolvedOutputSampleRateHz
    };
    this.sendConversationInitiation();
    return this.getState();
  }

  async fetchSignedUrl(agentId) {
    const base = normalizeElevenLabsBaseUrl(this.baseUrl);
    const url = new URL(base);
    url.pathname = "/v1/convai/conversation/get-signed-url";
    url.searchParams.set("agent_id", String(agentId));
    let response;
    try {
      response = await fetch(url.toString(), {
        method: "GET",
        headers: {
          "Content-Type": "application/json",
          "xi-api-key": this.apiKey
        }
      });
    } catch (error) {
      throw new Error(`Failed to fetch ElevenLabs signed URL: ${String(error?.message || error)}`);
    }

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(
        `ElevenLabs signed URL request failed (${response.status}): ${String(body || response.statusText || "unknown error")}`
      );
    }

    let payload = null;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }
    const signedUrl = String(payload?.signed_url || "").trim();
    if (!signedUrl) {
      throw new Error("ElevenLabs signed URL response did not include signed_url.");
    }
    return signedUrl;
  }

  async openSocket(url): Promise<WebSocket> {
    return await openRealtimeSocket({
      url,
      headers: {
        "Content-Type": "application/json"
      },
      timeoutMessage: "Timed out connecting to ElevenLabs realtime after 10000ms.",
      connectErrorPrefix: "ElevenLabs realtime connection failed"
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

    const eventType = String(event.type || "").trim().toLowerCase();
    if (!eventType) return;

    if (eventType === "conversation_initiation_metadata") {
      const metadata =
        event.conversation_initiation_metadata && typeof event.conversation_initiation_metadata === "object"
          ? event.conversation_initiation_metadata
          : {};
      const conversationId = String(metadata.conversation_id || "").trim();
      if (conversationId) {
        this.sessionId = conversationId;
      }
      const inputRate = parsePcmRateFromFormat(metadata.user_input_audio_format);
      const outputRate = parsePcmRateFromFormat(metadata.agent_output_audio_format);
      if (this.sessionConfig && inputRate) {
        this.sessionConfig.inputSampleRateHz = inputRate;
      }
      if (this.sessionConfig && outputRate) {
        this.sessionConfig.outputSampleRateHz = outputRate;
      }
      this.log("info", "elevenlabs_realtime_session_initiated", {
        sessionId: this.sessionId,
        userInputAudioFormat: metadata.user_input_audio_format || null,
        agentOutputAudioFormat: metadata.agent_output_audio_format || null
      });
      this.emit("session_metadata", metadata);
      return;
    }

    if (eventType === "audio") {
      const audioBase64 =
        typeof event.audio_event?.audio_base_64 === "string" ? String(event.audio_event.audio_base_64).trim() : "";
      if (audioBase64) {
        this.emit("audio_delta", audioBase64);
      }
      return;
    }

    if (eventType === "user_transcript") {
      const transcript = String(event.user_transcription_event?.user_transcript || "").trim();
      if (transcript) {
        this.emit("transcript", {
          text: transcript,
          eventType: "user_transcript"
        });
      }
      return;
    }

    if (eventType === "agent_response") {
      const transcript = String(event.agent_response_event?.agent_response || "").trim();
      if (transcript) {
        this.emit("transcript", {
          text: transcript,
          eventType: "agent_response"
        });
      }
      return;
    }

    if (eventType === "agent_response_correction") {
      const transcript = String(event.agent_response_correction_event?.corrected_agent_response || "").trim();
      if (transcript) {
        this.emit("transcript", {
          text: transcript,
          eventType: "agent_response_correction"
        });
      }
      return;
    }

    if (eventType === "ping") {
      const eventId = String(event.ping_event?.event_id || "").trim();
      if (eventId) {
        this.send({
          type: "pong",
          event_id: eventId
        });
      }
      return;
    }

    if (eventType === "interruption") {
      this.emit("response_done", {
        type: "response.done",
        response: {
          id: null,
          status: "interrupted"
        }
      });
      return;
    }

    if (eventType === "error" || event.error) {
      const details = event.error && typeof event.error === "object" ? event.error : {};
      const message =
        details.message || details.code || event.message || "Unknown ElevenLabs realtime error";
      this.lastError = String(message);
      this.log("warn", "elevenlabs_realtime_error_event", {
        error: this.lastError,
        code: details.code || null,
        param: details.param || null,
        lastOutboundEventType: this.lastOutboundEventType || null,
        lastOutboundEvent: this.lastOutboundEvent || null,
        recentOutboundEvents: this.recentOutboundEvents.slice(-4)
      });
      this.emit("error_event", {
        message: this.lastError,
        code: details.code || null,
        param: details.param || null,
        event,
        lastOutboundEventType: this.lastOutboundEventType || null,
        lastOutboundEvent: this.lastOutboundEvent || null,
        recentOutboundEvents: this.recentOutboundEvents.slice(-4)
      });
    }
  }

  sendConversationInitiation() {
    const instructions = String(this.sessionConfig?.instructions || "").trim();
    const conversationConfigOverride = instructions
      ? {
        agent: {
          prompt: {
            prompt: instructions
          }
        }
      }
      : null;
    this.send(
      compactObject({
        type: "conversation_initiation_client_data",
        conversation_config_override: conversationConfigOverride || undefined
      })
    );
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
    const normalized = String(audioBase64 || "").trim();
    if (!normalized) return;
    this.pendingInputAudioBase64.push(normalized);
  }

  commitInputAudioBuffer() {
    if (!Array.isArray(this.pendingInputAudioBase64) || this.pendingInputAudioBase64.length === 0) {
      return;
    }
    const chunks = this.pendingInputAudioBase64.slice();
    this.pendingInputAudioBase64 = [];
    for (const chunk of chunks) {
      this.send({
        user_audio_chunk: chunk
      });
    }
  }

  createAudioResponse() {
    this.send({
      type: "user_activity"
    });
  }

  cancelActiveResponse() {
    // ElevenLabs realtime currently interrupts via inbound audio/activity signaling.
    return false;
  }

  requestTextUtterance(promptText) {
    const prompt = String(promptText || "").trim();
    if (!prompt) return;
    this.send({
      type: "user_message",
      text: prompt
    });
  }

  send(payload) {
    const resolvedEventType = resolveOutboundType(payload);
    sendRealtimePayload(this, {
      payload,
      eventType: resolvedEventType,
      summarizeOutboundPayload,
      skipHistoryEventType: "user_audio_chunk",
      skipLogEventType: "user_audio_chunk",
      logEvent: "elevenlabs_realtime_client_event_sent",
      socketNotOpenMessage: "ElevenLabs realtime socket is not open."
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
    return {
      ...buildCommonRealtimeState(this),
      sessionConfig: this.sessionConfig
        ? {
          agentId: this.sessionConfig.agentId || null,
          inputSampleRateHz: this.sessionConfig.inputSampleRateHz || null,
          outputSampleRateHz: this.sessionConfig.outputSampleRateHz || null
        }
        : null,
      pendingInputChunks: Array.isArray(this.pendingInputAudioBase64) ? this.pendingInputAudioBase64.length : 0
    };
  }

  log(level, event, metadata = null) {
    if (!this.logger) return;
    this.logger({ level, event, metadata });
  }
}

function resolveOutboundType(payload) {
  if (!payload || typeof payload !== "object") return "unknown";
  if (typeof payload.type === "string" && payload.type.trim()) {
    return String(payload.type).trim();
  }
  if (typeof payload.user_audio_chunk === "string") return "user_audio_chunk";
  if (typeof payload.text === "string") return "user_message";
  return "unknown";
}

function summarizeOutboundPayload(payload) {
  if (!payload || typeof payload !== "object") return null;
  const type = resolveOutboundType(payload);

  if (type === "user_audio_chunk") {
    const audioChars = typeof payload.user_audio_chunk === "string" ? payload.user_audio_chunk.length : null;
    return compactObject({
      type,
      audioChars
    });
  }

  if (type === "user_message") {
    const text = String(payload.text || "").trim();
    return compactObject({
      type,
      textChars: text.length || null,
      textPreview: text ? text.slice(0, 180) : null
    });
  }

  if (type === "conversation_initiation_client_data") {
    const prompt =
      payload.conversation_config_override?.agent?.prompt?.prompt || "";
    return compactObject({
      type,
      hasPromptOverride: Boolean(String(prompt || "").trim()),
      promptChars: String(prompt || "").trim().length || null
    });
  }

  if (type === "pong" || type === "user_activity") {
    return compactObject({
      type
    });
  }

  return compactObject({
    type,
    payloadPreview: safeJsonPreview(payload, 220)
  });
}

function parsePcmRateFromFormat(format) {
  const normalized = String(format || "")
    .trim()
    .toLowerCase();
  if (!normalized) return null;
  const match = normalized.match(/^pcm_(\d{4,6})$/);
  if (!match?.[1]) return null;
  const parsed = Number(match[1]);
  if (!Number.isFinite(parsed)) return null;
  return Math.max(8000, Math.min(48000, Math.round(parsed)));
}

function normalizeElevenLabsBaseUrl(value) {
  const target = String(value || DEFAULT_ELEVENLABS_BASE_URL).trim() || DEFAULT_ELEVENLABS_BASE_URL;
  try {
    const parsed = new URL(target);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return DEFAULT_ELEVENLABS_BASE_URL;
    }
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return DEFAULT_ELEVENLABS_BASE_URL;
  }
}
