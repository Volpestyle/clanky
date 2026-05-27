import { EventEmitter } from "node:events";
import WebSocket from "ws";
import type {
	OpenAiRealtimeClientOptions,
	OpenAiRealtimeConnectOptions,
	OpenAiRealtimeTranscript,
} from "./openAiRealtimeClient.ts";
import { splitRealtimeInputAudioChunk, stringifyRealtimeFunctionOutput } from "./openAiRealtimeClient.ts";

type JsonRecord = Record<string, unknown>;

const DEFAULT_XAI_BASE_URL = "https://api.x.ai/v1";
const AUDIO_DELTA_EVENTS = new Set(["response.output_audio.delta", "response.audio.delta"]);
const TRANSCRIPT_EVENTS = new Set([
	"conversation.item.input_audio_transcription.completed",
	"response.output_audio_transcript.delta",
	"response.output_audio_transcript.done",
	"response.output_text.delta",
	"response.output_text.done",
	"response.text.delta",
	"response.text.done",
]);

export class XAiRealtimeClient extends EventEmitter {
	readonly supportsInputVideoFrames = false;
	private readonly apiKey: string;
	private readonly baseUrl: string;
	private readonly logger: OpenAiRealtimeClientOptions["logger"];
	private ws: WebSocket | undefined;
	private session: OpenAiRealtimeConnectOptions | undefined;
	private inputAudioRemainder: Buffer<ArrayBufferLike> = Buffer.alloc(0);
	private warnedAboutVideoFrames = false;

	constructor(options: OpenAiRealtimeClientOptions) {
		super();
		this.apiKey = options.apiKey.trim();
		this.baseUrl = (options.baseUrl ?? DEFAULT_XAI_BASE_URL).trim() || DEFAULT_XAI_BASE_URL;
		this.logger = options.logger;
	}

	async connect(options: OpenAiRealtimeConnectOptions): Promise<void> {
		if (this.apiKey.length === 0) throw new Error("XAI_API_KEY is required for Discord voice xAI realtime.");
		if ((options.responseOutputModality ?? "audio") === "audio" && options.voice.trim().length === 0) {
			throw new Error("An xAI realtime voice is required for Discord voice.");
		}
		if (this.ws?.readyState === WebSocket.OPEN) return;

		this.session = {
			...options,
			responseOutputModality: options.responseOutputModality ?? "audio",
			inputAudioFormat: options.inputAudioFormat ?? "pcm16",
			outputAudioFormat: options.outputAudioFormat ?? "pcm16",
			tools: options.tools ?? [],
			toolChoice: options.toolChoice ?? "auto",
		};
		const ws = await this.openSocket(buildXAiRealtimeUrl(this.baseUrl, options.model));
		this.ws = ws;
		ws.on("message", (data) => this.handleIncoming(data));
		ws.on("error", (error) => {
			this.logger?.("error", "xai_realtime_ws_error", { error: error.message });
			this.emit("socket_error", error);
		});
		ws.on("close", (code, reason) => {
			this.logger?.("warn", "xai_realtime_ws_closed", { code, reason: reason.toString("utf8") });
			this.emit("socket_closed", { code, reason: reason.toString("utf8") });
			if (this.ws === ws) this.ws = undefined;
		});
		this.sendSessionUpdate();
	}

	appendInputAudioPcm(audio: Buffer): void {
		const { event, remainder } = splitRealtimeInputAudioChunk(audio, this.inputAudioRemainder);
		this.inputAudioRemainder = remainder;
		if (event !== undefined) this.send(event);
	}

	commitInputAudioBuffer(): void {
		this.inputAudioRemainder = Buffer.alloc(0);
		this.send({ type: "input_audio_buffer.commit" });
	}

	cancelResponse(): void {
		this.send({ type: "response.cancel" });
	}

	createAudioResponse(): void {
		this.send({
			type: "response.create",
			response: { output_modalities: [this.session?.responseOutputModality ?? "audio"] },
		});
	}

	requestTextUtterance(text: string): void {
		const prompt = text.trim();
		if (prompt.length === 0) return;
		this.send({
			type: "conversation.item.create",
			item: {
				type: "message",
				role: "user",
				content: [{ type: "input_text", text: prompt }],
			},
		});
		this.createAudioResponse();
	}

	appendInputVideoFrame(_input: { mimeType: string; dataBase64: string }): void {
		if (this.warnedAboutVideoFrames) return;
		this.warnedAboutVideoFrames = true;
		this.logger?.("warn", "xai_realtime_video_frame_ignored", {
			reason: "xAI Voice Agent realtime image input is not supported by this adapter.",
		});
	}

	sendFunctionCallOutput(input: { callId: string; output: unknown }): void {
		this.send({
			type: "conversation.item.create",
			item: {
				type: "function_call_output",
				call_id: input.callId,
				output: stringifyRealtimeFunctionOutput(input.output),
			},
		});
	}

	async close(): Promise<void> {
		this.inputAudioRemainder = Buffer.alloc(0);
		const ws = this.ws;
		this.ws = undefined;
		if (ws === undefined || ws.readyState === WebSocket.CLOSED) return;
		await new Promise<void>((resolve) => {
			const timer = setTimeout(resolve, 1_000);
			ws.once("close", () => {
				clearTimeout(timer);
				resolve();
			});
			ws.close();
		});
	}

	updateTools(tools: NonNullable<OpenAiRealtimeConnectOptions["tools"]>): void {
		if (this.session === undefined) throw new Error("xAI realtime session is not connected.");
		this.session = { ...this.session, tools };
		this.sendSessionUpdate();
	}

	private async openSocket(url: string): Promise<WebSocket> {
		return await new Promise<WebSocket>((resolve, reject) => {
			const ws = new WebSocket(url, {
				headers: {
					Authorization: `Bearer ${this.apiKey}`,
				},
			});
			const timer = setTimeout(() => {
				ws.close();
				reject(new Error("Timed out connecting to xAI realtime after 10000ms."));
			}, 10_000);
			ws.once("open", () => {
				clearTimeout(timer);
				resolve(ws);
			});
			ws.once("error", (error) => {
				clearTimeout(timer);
				reject(error);
			});
		});
	}

	private sendSessionUpdate(): void {
		const session = this.session;
		if (session === undefined) return;
		this.send(buildXAiRealtimeSessionUpdateEvent(session));
	}

	private send(payload: JsonRecord): void {
		if (this.ws === undefined || this.ws.readyState !== WebSocket.OPEN) {
			throw new Error("xAI realtime socket is not open.");
		}
		this.ws.send(JSON.stringify(payload));
	}

	private handleIncoming(data: WebSocket.RawData): void {
		const event = parseJsonRecord(data);
		if (event === undefined) return;
		this.emit("event", event);
		if (AUDIO_DELTA_EVENTS.has(stringValue(event.type))) {
			const audio = stringValue(event.delta) || stringValue(event.audio);
			if (audio.length > 0) this.emit("audio_delta", audio);
			return;
		}
		if (TRANSCRIPT_EVENTS.has(stringValue(event.type))) {
			const text = stringValue(event.transcript) || stringValue(event.text) || stringValue(event.delta);
			if (text.length > 0 || stringValue(event.type).endsWith(".done")) {
				const itemId = stringValue(event.item_id) || stringValue(event.itemId);
				const transcript: OpenAiRealtimeTranscript = {
					text,
					eventType: normalizeXAiTranscriptEventType(stringValue(event.type)),
				};
				if (itemId.length > 0) transcript.itemId = itemId;
				this.emit("transcript", transcript);
			}
			return;
		}
		if (stringValue(event.type) === "error") {
			this.emit("error_event", event);
			this.logger?.("warn", "xai_realtime_error_event", event);
		}
	}
}

export function buildXAiRealtimeSessionUpdateEvent(session: OpenAiRealtimeConnectOptions): JsonRecord {
	const outputModality = session.responseOutputModality ?? "audio";
	const audio: JsonRecord = {
		input: {
			format: xAiRealtimeAudioFormat(session.inputAudioFormat),
		},
	};
	if (outputModality === "audio") {
		audio.output = {
			format: xAiRealtimeAudioFormat(session.outputAudioFormat),
		};
	}
	return {
		type: "session.update",
		session: {
			instructions: session.instructions,
			voice: session.voice,
			turn_detection: null,
			output_modalities: [outputModality],
			audio,
			tools: session.tools ?? [],
			tool_choice: session.toolChoice ?? "auto",
		},
	};
}

function buildXAiRealtimeUrl(baseUrl: string, model: string): string {
	const url = new URL(baseUrl);
	url.protocol = url.protocol === "http:" ? "ws:" : "wss:";
	url.pathname = `${url.pathname.replace(/\/+$/, "")}/realtime`;
	url.searchParams.set("model", model);
	return url.toString();
}

function xAiRealtimeAudioFormat(format: "pcm16" | undefined): JsonRecord {
	if (format !== undefined && format !== "pcm16") throw new Error(`Unsupported xAI realtime audio format: ${format}`);
	return { type: "audio/pcm", rate: 24_000 };
}

function normalizeXAiTranscriptEventType(eventType: string): string {
	if (eventType === "response.text.delta") return "response.output_text.delta";
	if (eventType === "response.text.done") return "response.output_text.done";
	return eventType;
}

function parseJsonRecord(data: WebSocket.RawData): JsonRecord | undefined {
	try {
		const parsed = JSON.parse(Buffer.isBuffer(data) ? data.toString("utf8") : String(data));
		if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as JsonRecord;
		return undefined;
	} catch {
		return undefined;
	}
}

function stringValue(value: unknown): string {
	return typeof value === "string" ? value : "";
}

export const __xaiRealtimeTestHooks = {
	buildXAiRealtimeUrl,
	normalizeXAiTranscriptEventType,
};
