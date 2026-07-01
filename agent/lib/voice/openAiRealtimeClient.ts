import type { JsonRecord } from "./json.ts";
import { buildRealtimeWsUrl, RealtimeWsClientBase } from "./realtimeWsClientBase.ts";

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
	responseOutputModality?: OpenAiRealtimeOutputModality;
	inputAudioFormat?: "pcm16";
	outputAudioFormat?: "pcm16";
	inputTranscriptionModel?: string;
}

export type OpenAiRealtimeOutputModality = "audio" | "text";
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
	itemId?: string;
}

const DEFAULT_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_INPUT_TRANSCRIPTION_MODEL = "gpt-4o-mini-transcribe";

export class OpenAiRealtimeClient extends RealtimeWsClientBase {
	readonly supportsInputVideoFrames = true;
	private readonly apiKey: string;
	private readonly baseUrl: string;
	private readonly safetyIdentifier: string | undefined;

	constructor(options: OpenAiRealtimeClientOptions) {
		super({ logEventPrefix: "openai_realtime", logger: options.logger });
		this.apiKey = options.apiKey.trim();
		this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).trim() || DEFAULT_BASE_URL;
		this.safetyIdentifier = options.safetyIdentifier?.trim() || undefined;
	}

	async connect(options: OpenAiRealtimeConnectOptions): Promise<void> {
		if (this.apiKey.length === 0) throw new Error("OPENAI_API_KEY is required for Discord voice realtime.");
		if ((options.responseOutputModality ?? "audio") === "audio" && options.voice.trim().length === 0) {
			throw new Error("A realtime voice is required for Discord voice.");
		}
		if (this.isSocketOpen) return;

		this.session = {
			...options,
			responseOutputModality: options.responseOutputModality ?? "audio",
			inputAudioFormat: options.inputAudioFormat ?? "pcm16",
			outputAudioFormat: options.outputAudioFormat ?? "pcm16",
			inputTranscriptionModel: options.inputTranscriptionModel ?? DEFAULT_INPUT_TRANSCRIPTION_MODEL,
			tools: options.tools ?? [],
			toolChoice: options.toolChoice ?? "auto",
		};
		const headers: Record<string, string> = {
			Authorization: `Bearer ${this.apiKey}`,
		};
		if (this.safetyIdentifier !== undefined) headers["OpenAI-Safety-Identifier"] = this.safetyIdentifier;
		await this.openAndBindSocket(buildRealtimeWsUrl(this.baseUrl, options.model), headers);
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

	protected buildSessionUpdateEvent(session: OpenAiRealtimeConnectOptions): JsonRecord {
		return buildRealtimeSessionUpdateEvent(session);
	}
}

export function buildRealtimeSessionUpdateEvent(session: OpenAiRealtimeConnectOptions): JsonRecord {
	const outputModality = session.responseOutputModality ?? "audio";
	const audio: JsonRecord = {
		input: {
			format: realtimeAudioFormat(session.inputAudioFormat),
			transcription: { model: session.inputTranscriptionModel ?? DEFAULT_INPUT_TRANSCRIPTION_MODEL },
			turn_detection: null,
		},
	};
	if (outputModality === "audio") {
		audio.output = {
			format: realtimeAudioFormat(session.outputAudioFormat),
			voice: session.voice,
		};
	}
	return {
		type: "session.update",
		session: {
			type: "realtime",
			model: session.model,
			instructions: session.instructions,
			output_modalities: [outputModality],
			audio,
			tools: session.tools ?? [],
			tool_choice: session.toolChoice ?? "auto",
			...(session.reasoningEffort !== undefined ? { reasoning: { effort: session.reasoningEffort } } : {}),
		},
	};
}

function realtimeAudioFormat(format: "pcm16" | undefined): JsonRecord {
	if (format !== undefined && format !== "pcm16") throw new Error(`Unsupported realtime audio format: ${format}`);
	return { type: "audio/pcm", rate: 24_000 };
}
