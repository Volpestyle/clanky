import type { JsonRecord } from "./json.ts";
import type { OpenAiRealtimeClientOptions, OpenAiRealtimeConnectOptions } from "./openAiRealtimeClient.ts";
import { buildRealtimeWsUrl, RealtimeWsClientBase } from "./realtimeWsClientBase.ts";

const DEFAULT_XAI_BASE_URL = "https://api.x.ai/v1";

export class XAiRealtimeClient extends RealtimeWsClientBase {
	readonly supportsInputVideoFrames = false;
	private readonly apiKey: string;
	private readonly baseUrl: string;
	private warnedAboutVideoFrames = false;

	constructor(options: OpenAiRealtimeClientOptions) {
		super({ logEventPrefix: "xai_realtime", logger: options.logger });
		this.apiKey = options.apiKey.trim();
		this.baseUrl = (options.baseUrl ?? DEFAULT_XAI_BASE_URL).trim() || DEFAULT_XAI_BASE_URL;
	}

	async connect(options: OpenAiRealtimeConnectOptions): Promise<void> {
		if (this.apiKey.length === 0) throw new Error("XAI_API_KEY is required for Discord voice xAI realtime.");
		if ((options.responseOutputModality ?? "audio") === "audio" && options.voice.trim().length === 0) {
			throw new Error("An xAI realtime voice is required for Discord voice.");
		}
		if (this.isSocketOpen) return;

		this.session = {
			...options,
			responseOutputModality: options.responseOutputModality ?? "audio",
			inputAudioFormat: options.inputAudioFormat ?? "pcm16",
			outputAudioFormat: options.outputAudioFormat ?? "pcm16",
			tools: options.tools ?? [],
			toolChoice: options.toolChoice ?? "auto",
		};
		await this.openAndBindSocket(buildRealtimeWsUrl(this.baseUrl, options.model), {
			Authorization: `Bearer ${this.apiKey}`,
		});
	}

	appendInputVideoFrame(_input: { mimeType: string; dataBase64: string }): void {
		if (this.warnedAboutVideoFrames) return;
		this.warnedAboutVideoFrames = true;
		this.logger?.("warn", "xai_realtime_video_frame_ignored", {
			reason: "xAI Voice Agent realtime image input is not supported by this adapter.",
		});
	}

	protected buildSessionUpdateEvent(session: OpenAiRealtimeConnectOptions): JsonRecord {
		return buildXAiRealtimeSessionUpdateEvent(session);
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

function xAiRealtimeAudioFormat(format: "pcm16" | undefined): JsonRecord {
	if (format !== undefined && format !== "pcm16") throw new Error(`Unsupported xAI realtime audio format: ${format}`);
	return { type: "audio/pcm", rate: 24_000 };
}
