/**
 * Shared WebSocket core for the hosted realtime voice clients (OpenAI, xAI).
 * Owns the socket lifecycle, drop-and-log send semantics, incoming flow
 * control, and the reconciled audio/transcript event classification, so the
 * per-provider clients only differ in connect validation and session.update
 * payloads.
 */
import { EventEmitter } from "node:events";
import { type JsonRecord, stringValue } from "./json.ts";
import WebSocket from "ws";
import type {
	OpenAiRealtimeClientOptions,
	OpenAiRealtimeConnectOptions,
	OpenAiRealtimeTool,
	OpenAiRealtimeTranscript,
} from "./openAiRealtimeClient.ts";

export const REALTIME_CONNECT_TIMEOUT_MS = 10_000;
export const REALTIME_CLOSE_TIMEOUT_MS = 1_000;

export const REALTIME_AUDIO_DELTA_EVENTS = new Set(["response.output_audio.delta", "response.audio.delta"]);

/**
 * Reconciled union of the transcript-bearing event types the providers emit.
 * The OpenAI and xAI clients used to keep divergent copies of this set, so
 * each silently dropped transcripts the other handled (xAI missed input
 * transcription deltas; OpenAI missed the legacy response.text.* names).
 */
export const REALTIME_TRANSCRIPT_EVENTS = new Set([
	"conversation.item.input_audio_transcription.delta",
	"conversation.item.input_audio_transcription.completed",
	"response.output_audio_transcript.delta",
	"response.output_audio_transcript.done",
	"response.output_text.delta",
	"response.output_text.done",
	"response.text.delta",
	"response.text.done",
]);

export type RealtimeIncomingClassification =
	| { kind: "audio_delta"; audioBase64: string }
	| { kind: "transcript"; transcript: OpenAiRealtimeTranscript }
	| { kind: "error_event" }
	| { kind: "other" };

/** xAI still emits the legacy response.text.* names; downstream consumers key on response.output_text.*. */
export function normalizeRealtimeTranscriptEventType(eventType: string): string {
	if (eventType === "response.text.delta") return "response.output_text.delta";
	if (eventType === "response.text.done") return "response.output_text.done";
	return eventType;
}

/**
 * Classify an incoming realtime event into the audio/transcript/error surface
 * the voice stack consumes. Terminal transcript events (*.done / *.completed)
 * are emitted even with empty text: the external TTS bridge flushes its
 * per-item delta buffer on them, and the speaker tracker's FIFO must stay 1:1
 * with input transcript completions (a silently dropped blank completion would
 * shift a later turn's speakers onto the wrong transcript).
 */
export function classifyRealtimeEvent(event: JsonRecord): RealtimeIncomingClassification {
	const rawType = stringValue(event.type);
	if (REALTIME_AUDIO_DELTA_EVENTS.has(rawType)) {
		const audio = stringValue(event.delta) || stringValue(event.audio);
		return audio.length > 0 ? { kind: "audio_delta", audioBase64: audio } : { kind: "other" };
	}
	if (REALTIME_TRANSCRIPT_EVENTS.has(rawType)) {
		const eventType = normalizeRealtimeTranscriptEventType(rawType);
		const text = stringValue(event.transcript) || stringValue(event.text) || stringValue(event.delta);
		const terminal = eventType.endsWith(".done") || eventType.endsWith(".completed");
		if (text.length === 0 && !terminal) return { kind: "other" };
		const itemId = stringValue(event.item_id) || stringValue(event.itemId);
		const transcript: OpenAiRealtimeTranscript = { text, eventType };
		if (itemId.length > 0) transcript.itemId = itemId;
		return { kind: "transcript", transcript };
	}
	if (rawType === "error") return { kind: "error_event" };
	return { kind: "other" };
}

export function buildRealtimeWsUrl(baseUrl: string, model: string): string {
	const url = new URL(baseUrl);
	url.protocol = url.protocol === "http:" ? "ws:" : "wss:";
	url.pathname = `${url.pathname.replace(/\/+$/, "")}/realtime`;
	url.searchParams.set("model", model);
	return url.toString();
}

export function parseRealtimeJsonRecord(data: WebSocket.RawData): JsonRecord | undefined {
	try {
		const parsed = JSON.parse(Buffer.isBuffer(data) ? data.toString("utf8") : String(data));
		if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as JsonRecord;
		return undefined;
	} catch {
		return undefined;
	}
}

export interface RealtimeWsClientBaseConfig {
	/** Log event prefix, e.g. "openai_realtime". */
	logEventPrefix: string;
	logger: OpenAiRealtimeClientOptions["logger"];
}

export abstract class RealtimeWsClientBase extends EventEmitter {
	protected readonly logger: OpenAiRealtimeClientOptions["logger"];
	private readonly logEventPrefix: string;
	private ws: WebSocket | undefined;
	protected session: OpenAiRealtimeConnectOptions | undefined;
	private inputAudioRemainder: Buffer<ArrayBufferLike> = Buffer.alloc(0);
	private incomingPaused = false;
	private droppedSendCount = 0;

	constructor(config: RealtimeWsClientBaseConfig) {
		super();
		this.logEventPrefix = config.logEventPrefix;
		this.logger = config.logger;
	}

	/** Provider-specific session.update payload. */
	protected abstract buildSessionUpdateEvent(session: OpenAiRealtimeConnectOptions): JsonRecord;

	protected get isSocketOpen(): boolean {
		return this.ws?.readyState === WebSocket.OPEN;
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

	pauseIncoming(): void {
		if (this.incomingPaused) return;
		this.incomingPaused = true;
		this.applyIncomingFlowControl();
		this.logger?.("info", `${this.logEventPrefix}_incoming_paused`);
	}

	resumeIncoming(): void {
		if (!this.incomingPaused) return;
		this.incomingPaused = false;
		this.applyIncomingFlowControl();
		this.logger?.("info", `${this.logEventPrefix}_incoming_resumed`);
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

	updateTools(tools: OpenAiRealtimeTool[]): void {
		if (this.session === undefined) throw new Error("Realtime session is not connected.");
		this.session = { ...this.session, tools };
		this.sendSessionUpdate();
	}

	async close(): Promise<void> {
		this.inputAudioRemainder = Buffer.alloc(0);
		this.incomingPaused = false;
		const ws = this.ws;
		this.ws = undefined;
		if (ws === undefined || ws.readyState === WebSocket.CLOSED) return;
		await new Promise<void>((resolve) => {
			const timer = setTimeout(resolve, REALTIME_CLOSE_TIMEOUT_MS);
			ws.once("close", () => {
				clearTimeout(timer);
				resolve();
			});
			ws.close();
		});
	}

	/** Open the socket, bind lifecycle handlers, and send the initial session.update. */
	protected async openAndBindSocket(url: string, headers: Record<string, string>): Promise<void> {
		this.incomingPaused = false;
		const ws = await new Promise<WebSocket>((resolve, reject) => {
			const socket = new WebSocket(url, { headers });
			const timer = setTimeout(() => {
				socket.close();
				reject(new Error(`Timed out connecting to ${this.logEventPrefix} after ${REALTIME_CONNECT_TIMEOUT_MS}ms.`));
			}, REALTIME_CONNECT_TIMEOUT_MS);
			socket.once("open", () => {
				clearTimeout(timer);
				resolve(socket);
			});
			socket.once("error", (error) => {
				clearTimeout(timer);
				reject(error);
			});
		});
		this.ws = ws;
		this.applyIncomingFlowControl(ws);
		ws.on("message", (data) => this.handleIncoming(data));
		ws.on("error", (error) => {
			this.logger?.("error", `${this.logEventPrefix}_ws_error`, { error: error.message });
			this.emit("socket_error", error);
		});
		ws.on("close", (code, reason) => {
			this.logger?.("warn", `${this.logEventPrefix}_ws_closed`, { code, reason: reason.toString("utf8") });
			this.emit("socket_closed", { code, reason: reason.toString("utf8") });
			if (this.ws === ws) {
				this.ws = undefined;
				this.incomingPaused = false;
			}
		});
		this.sendSessionUpdate();
	}

	protected sendSessionUpdate(): void {
		const session = this.session;
		if (session === undefined) return;
		this.send(this.buildSessionUpdateEvent(session));
	}

	private applyIncomingFlowControl(ws = this.ws): void {
		if (ws === undefined || ws.readyState !== WebSocket.OPEN) return;
		if (this.incomingPaused) ws.pause();
		else ws.resume();
	}

	/**
	 * Send-on-closed drops and logs instead of throwing: sends fire from event
	 * listeners all over the voice stack (vox frames, turn-buffer flushes, tool
	 * results), and a WS drop between check and call would otherwise surface as
	 * an uncaught exception in the brain. The socket_closed event already faults
	 * the session; dropped sends are the tail of a dying connection.
	 */
	protected send(payload: JsonRecord): void {
		const ws = this.ws;
		if (ws === undefined || ws.readyState !== WebSocket.OPEN) {
			this.droppedSendCount += 1;
			this.logger?.("warn", `${this.logEventPrefix}_send_dropped`, {
				type: stringValue(payload.type),
				droppedSendCount: this.droppedSendCount,
			});
			return;
		}
		ws.send(JSON.stringify(payload));
	}

	private handleIncoming(data: WebSocket.RawData): void {
		const event = parseRealtimeJsonRecord(data);
		if (event === undefined) return;
		this.emit("event", event);
		const classified = classifyRealtimeEvent(event);
		if (classified.kind === "audio_delta") {
			this.emit("audio_delta", classified.audioBase64);
			return;
		}
		if (classified.kind === "transcript") {
			this.emit("transcript", classified.transcript);
			return;
		}
		if (classified.kind === "error_event") {
			this.emit("error_event", event);
			this.logger?.("warn", `${this.logEventPrefix}_error_event`, event);
		}
	}
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
