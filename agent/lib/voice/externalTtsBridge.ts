import type { ElevenLabsTtsAudioChunk } from "./elevenLabsTtsClient.ts";
import type { JsonRecord } from "./json.ts";
import type { OpenAiRealtimeTranscript } from "./openAiRealtimeClient.ts";

export interface ExternalTtsTranscriptSource {
	on(event: "transcript", listener: (transcript: OpenAiRealtimeTranscript) => void): unknown;
	off?(event: "transcript", listener: (transcript: OpenAiRealtimeTranscript) => void): unknown;
}

export interface ExternalTtsSynthesizer {
	synthesize(
		text: string,
		onAudio: (chunk: ElevenLabsTtsAudioChunk) => Promise<void> | void,
		options?: { signal?: AbortSignal },
	): Promise<void>;
}

export interface ExternalTtsOutputStats {
	externalTtsRequestCount: number;
	discordOutputAudioSendCount: number;
}

export interface ExternalTtsOutputBinding {
	dispose(): void;
}

export interface BindExternalTtsOutputOptions {
	realtime: ExternalTtsTranscriptSource;
	tts: ExternalTtsSynthesizer;
	playAudio(chunk: ElevenLabsTtsAudioChunk): void;
	stopPlayback?(): void;
	stats?: ExternalTtsOutputStats;
	logger?: (level: "info" | "warn" | "error", event: string, details?: JsonRecord) => void;
}

const DEFAULT_ITEM_ID = "__default__";
const OUTPUT_TEXT_DELTA_EVENTS = new Set(["response.output_text.delta"]);
const OUTPUT_TEXT_DONE_EVENTS = new Set(["response.output_text.done"]);
/** Items whose .done never arrives (cancelled responses) must not accumulate forever. */
const MAX_BUFFERED_ITEMS = 32;

export function bindExternalTtsOutput(options: BindExternalTtsOutputOptions): ExternalTtsOutputBinding {
	return new ExternalTtsOutputBridge(options);
}

class ExternalTtsOutputBridge implements ExternalTtsOutputBinding {
	private readonly realtime: ExternalTtsTranscriptSource;
	private readonly tts: ExternalTtsSynthesizer;
	private readonly playAudio: (chunk: ElevenLabsTtsAudioChunk) => void;
	private readonly stopPlayback: (() => void) | undefined;
	private readonly stats: ExternalTtsOutputStats | undefined;
	private readonly logger: BindExternalTtsOutputOptions["logger"];
	private readonly transcriptListener: (transcript: OpenAiRealtimeTranscript) => void;
	private readonly textByItemId = new Map<string, string[]>();
	private queue: Promise<void> = Promise.resolve();
	private currentAbort: AbortController | undefined;
	private disposed = false;

	constructor(options: BindExternalTtsOutputOptions) {
		this.realtime = options.realtime;
		this.tts = options.tts;
		this.playAudio = options.playAudio;
		this.stopPlayback = options.stopPlayback;
		this.stats = options.stats;
		this.logger = options.logger;
		this.transcriptListener = (transcript) => this.handleTranscript(transcript);
		this.realtime.on("transcript", this.transcriptListener);
	}

	dispose(): void {
		this.disposed = true;
		this.realtime.off?.("transcript", this.transcriptListener);
		this.currentAbort?.abort();
		this.stopPlayback?.();
		this.textByItemId.clear();
	}

	private handleTranscript(transcript: OpenAiRealtimeTranscript): void {
		if (this.disposed) return;
		if (OUTPUT_TEXT_DELTA_EVENTS.has(transcript.eventType)) {
			this.appendText(transcript);
			return;
		}
		if (OUTPUT_TEXT_DONE_EVENTS.has(transcript.eventType)) {
			this.completeText(transcript);
		}
	}

	private appendText(transcript: OpenAiRealtimeTranscript): void {
		if (transcript.text.length === 0) return;
		const itemId = transcript.itemId ?? DEFAULT_ITEM_ID;
		const chunks = this.textByItemId.get(itemId) ?? [];
		chunks.push(transcript.text);
		this.textByItemId.set(itemId, chunks);
		while (this.textByItemId.size > MAX_BUFFERED_ITEMS) {
			const oldest = this.textByItemId.keys().next().value;
			if (oldest === undefined) break;
			this.textByItemId.delete(oldest);
		}
	}

	private completeText(transcript: OpenAiRealtimeTranscript): void {
		const itemId = transcript.itemId ?? DEFAULT_ITEM_ID;
		const buffered = (this.textByItemId.get(itemId) ?? []).join("");
		this.textByItemId.delete(itemId);
		const text = transcript.text.trim().length > 0 ? transcript.text : buffered;
		this.enqueueSynthesis(text);
	}

	private enqueueSynthesis(text: string): void {
		const prompt = text.trim();
		if (prompt.length === 0) return;
		this.queue = this.queue.then(() => this.runSynthesis(prompt)).catch((error: unknown) => {
			this.logger?.("error", "external_tts_synthesis_failed", {
				error: error instanceof Error ? error.message : String(error),
			});
		});
	}

	private async runSynthesis(text: string): Promise<void> {
		if (this.disposed) return;
		const abort = new AbortController();
		this.currentAbort = abort;
		if (this.stats !== undefined) this.stats.externalTtsRequestCount += 1;
		try {
			await this.tts.synthesize(
				text,
				(chunk) => {
					if (this.disposed || abort.signal.aborted) return;
					this.playAudio(chunk);
					if (this.stats !== undefined) this.stats.discordOutputAudioSendCount += 1;
				},
				{ signal: abort.signal },
			);
		} finally {
			if (this.currentAbort === abort) this.currentAbort = undefined;
		}
	}
}
