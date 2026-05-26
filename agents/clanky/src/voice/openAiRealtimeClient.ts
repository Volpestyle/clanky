import { EventEmitter } from "node:events";
import WebSocket from "ws";

type JsonRecord = Record<string, unknown>;

export interface OpenAiRealtimeTool {
	type: "function";
	name: string;
	description: string;
	parameters: JsonRecord;
}

export interface OpenAiRealtimeConnectOptions {
	model: string;
	voice: string;
	instructions: string;
	tools?: OpenAiRealtimeTool[];
	toolChoice?: "auto" | "none" | "required";
	reasoningEffort?: OpenAiRealtimeReasoningEffort;
	inputAudioFormat?: "pcm16";
	outputAudioFormat?: "pcm16";
	inputTranscriptionModel?: string;
}

export type OpenAiRealtimeReasoningEffort = "minimal" | "low" | "medium" | "high" | "xhigh";

export interface OpenAiRealtimeClientOptions {
	apiKey: string;
	baseUrl?: string;
	safetyIdentifier?: string;
	logger?: (level: "info" | "warn" | "error", event: string, details?: JsonRecord) => void;
}

export interface OpenAiRealtimeTranscript {
	text: string;
	eventType: string;
}

const DEFAULT_BASE_URL = "https://api.openai.com/v1";
const AUDIO_DELTA_EVENTS = new Set(["response.output_audio.delta", "response.audio.delta"]);
const TRANSCRIPT_EVENTS = new Set([
	"conversation.item.input_audio_transcription.delta",
	"conversation.item.input_audio_transcription.completed",
	"response.output_audio_transcript.delta",
	"response.output_audio_transcript.done",
	"response.output_text.delta",
	"response.output_text.done",
]);

export class OpenAiRealtimeClient extends EventEmitter {
	private readonly apiKey: string;
	private readonly baseUrl: string;
	private readonly safetyIdentifier: string | undefined;
	private readonly logger: OpenAiRealtimeClientOptions["logger"];
	private ws: WebSocket | undefined;
	private session: OpenAiRealtimeConnectOptions | undefined;
	private inputAudioRemainder: Buffer<ArrayBufferLike> = Buffer.alloc(0);

	constructor(options: OpenAiRealtimeClientOptions) {
		super();
		this.apiKey = options.apiKey.trim();
		this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).trim() || DEFAULT_BASE_URL;
		this.safetyIdentifier = options.safetyIdentifier?.trim() || undefined;
		this.logger = options.logger;
	}

	async connect(options: OpenAiRealtimeConnectOptions): Promise<void> {
		if (this.apiKey.length === 0) throw new Error("OPENAI_API_KEY is required for Discord voice realtime.");
		if (options.voice.trim().length === 0) throw new Error("A realtime voice is required for Discord voice.");
		if (this.ws?.readyState === WebSocket.OPEN) return;

		this.session = {
			...options,
			inputAudioFormat: options.inputAudioFormat ?? "pcm16",
			outputAudioFormat: options.outputAudioFormat ?? "pcm16",
			inputTranscriptionModel: options.inputTranscriptionModel ?? "gpt-4o-mini-transcribe",
			tools: options.tools ?? [],
			toolChoice: options.toolChoice ?? "auto",
		};
		const ws = await this.openSocket(this.buildRealtimeUrl(options.model));
		this.ws = ws;
		ws.on("message", (data) => this.handleIncoming(data));
		ws.on("error", (error) => {
			this.logger?.("error", "openai_realtime_ws_error", { error: error.message });
			this.emit("socket_error", error);
		});
		ws.on("close", (code, reason) => {
			this.logger?.("warn", "openai_realtime_ws_closed", { code, reason: reason.toString("utf8") });
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

	createAudioResponse(): void {
		this.send({ type: "response.create", response: { output_modalities: ["audio"] } });
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

	appendInputVideoFrame(input: { mimeType: string; dataBase64: string }): void {
		const imageUrl = `data:${input.mimeType};base64,${input.dataBase64}`;
		this.send({
			type: "conversation.item.create",
			item: {
				type: "message",
				role: "user",
				content: [
					{ type: "input_text", text: "Latest Discord screen-share frame." },
					{ type: "input_image", image_url: imageUrl },
				],
			},
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

	updateTools(tools: OpenAiRealtimeTool[]): void {
		if (this.session === undefined) throw new Error("Realtime session is not connected.");
		this.session = { ...this.session, tools };
		this.sendSessionUpdate();
	}

	private buildRealtimeUrl(model: string): string {
		const url = new URL(this.baseUrl);
		url.protocol = url.protocol === "http:" ? "ws:" : "wss:";
		url.pathname = `${url.pathname.replace(/\/+$/, "")}/realtime`;
		url.searchParams.set("model", model);
		return url.toString();
	}

	private async openSocket(url: string): Promise<WebSocket> {
		return await new Promise<WebSocket>((resolve, reject) => {
			const headers: Record<string, string> = {
				Authorization: `Bearer ${this.apiKey}`,
			};
			if (this.safetyIdentifier !== undefined) headers["OpenAI-Safety-Identifier"] = this.safetyIdentifier;
			const ws = new WebSocket(url, {
				headers,
			});
			const timer = setTimeout(() => {
				ws.close();
				reject(new Error("Timed out connecting to OpenAI realtime after 10000ms."));
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
		this.send(buildRealtimeSessionUpdateEvent(session));
	}

	private send(payload: JsonRecord): void {
		if (this.ws === undefined || this.ws.readyState !== WebSocket.OPEN) {
			throw new Error("OpenAI realtime socket is not open.");
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
			if (text.length > 0) {
				const transcript: OpenAiRealtimeTranscript = { text, eventType: stringValue(event.type) };
				this.emit("transcript", transcript);
			}
			return;
		}
		if (stringValue(event.type) === "error") {
			this.emit("error_event", event);
			this.logger?.("warn", "openai_realtime_error_event", event);
		}
	}
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

export function buildRealtimeSessionUpdateEvent(session: OpenAiRealtimeConnectOptions): JsonRecord {
	return {
		type: "session.update",
		session: {
			type: "realtime",
			model: session.model,
			instructions: session.instructions,
			output_modalities: ["audio"],
			audio: {
				input: {
					format: session.inputAudioFormat ?? "pcm16",
					transcription: { model: session.inputTranscriptionModel ?? "gpt-4o-mini-transcribe" },
					turn_detection: null,
				},
				output: {
					format: session.outputAudioFormat ?? "pcm16",
					voice: session.voice,
				},
			},
			tools: session.tools ?? [],
			tool_choice: session.toolChoice ?? "auto",
			...(session.reasoningEffort !== undefined ? { reasoning: { effort: session.reasoningEffort } } : {}),
		},
	};
}

export function buildInputAudioAppendEvent(audio: Buffer): JsonRecord | undefined {
	if (audio.length === 0) return undefined;
	return { type: "input_audio_buffer.append", audio: audio.toString("base64") };
}

export function splitRealtimeInputAudioChunk(
	audio: Buffer,
	remainder: Buffer = Buffer.alloc(0),
): { event?: JsonRecord; remainder: Buffer<ArrayBufferLike> } {
	const combined = remainder.length > 0 ? Buffer.concat([remainder, audio]) : audio;
	if (combined.length === 0) return { remainder: Buffer.alloc(0) };
	const sendLength = combined.length - (combined.length % 6);
	const nextRemainder = sendLength < combined.length ? Buffer.from(combined.subarray(sendLength)) : Buffer.alloc(0);
	if (sendLength <= 0) return { remainder: nextRemainder };
	const event = buildInputAudioAppendEvent(combined.subarray(0, sendLength));
	return event === undefined ? { remainder: nextRemainder } : { event, remainder: nextRemainder };
}

export function stringifyRealtimeFunctionOutput(output: unknown): string {
	if (typeof output === "string") return output;
	if (output === undefined) return "null";
	try {
		const serialized = JSON.stringify(output);
		return serialized ?? JSON.stringify(String(output));
	} catch (error) {
		return JSON.stringify({
			ok: false,
			error: "Failed to serialize realtime function output.",
			detail: error instanceof Error ? error.message : String(error),
		});
	}
}
