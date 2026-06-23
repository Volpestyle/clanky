import type { JsonRecord } from "./json.ts";

export type ElevenLabsPcmOutputFormat = "pcm_16000" | "pcm_22050" | "pcm_24000" | "pcm_44100";

export interface ElevenLabsTtsClientOptions {
	apiKey: string;
	voiceId: string;
	modelId: string;
	baseUrl?: string;
	outputFormat?: ElevenLabsPcmOutputFormat;
	speed?: number;
	logger?: (level: "info" | "warn" | "error", event: string, details?: JsonRecord) => void;
}

export interface ElevenLabsTtsAudioChunk {
	pcmBase64: string;
	sampleRate: number;
}

export interface ElevenLabsTtsSynthesizeOptions {
	signal?: AbortSignal;
}

export const DEFAULT_ELEVENLABS_TTS_MODEL = "eleven_flash_v2_5";
export const DEFAULT_ELEVENLABS_OUTPUT_FORMAT: ElevenLabsPcmOutputFormat = "pcm_24000";
export const DEFAULT_ELEVENLABS_SPEED = 1.1;

const DEFAULT_ELEVENLABS_BASE_URL = "https://api.elevenlabs.io";
const MIN_STREAM_FLUSH_MS = 80;
const MAX_STREAM_FLUSH_MS = 160;

export class ElevenLabsTtsClient {
	private readonly apiKey: string;
	private readonly voiceId: string;
	private readonly modelId: string;
	private readonly baseUrl: string;
	private readonly outputFormat: ElevenLabsPcmOutputFormat;
	private readonly speed: number;
	private readonly logger: ElevenLabsTtsClientOptions["logger"];

	constructor(options: ElevenLabsTtsClientOptions) {
		this.apiKey = options.apiKey.trim();
		this.voiceId = options.voiceId.trim();
		this.modelId = options.modelId.trim();
		this.baseUrl = (options.baseUrl ?? DEFAULT_ELEVENLABS_BASE_URL).replace(/\/+$/, "");
		this.outputFormat = options.outputFormat ?? DEFAULT_ELEVENLABS_OUTPUT_FORMAT;
		this.speed = normalizeSpeed(options.speed);
		this.logger = options.logger;
	}

	async synthesize(
		text: string,
		onAudio: (chunk: ElevenLabsTtsAudioChunk) => Promise<void> | void,
		options: ElevenLabsTtsSynthesizeOptions = {},
	): Promise<void> {
		const prompt = text.trim();
		if (prompt.length === 0) return;
		if (isAbortSignalAborted(options.signal)) return;
		if (this.apiKey.length === 0) throw new Error("ELEVENLABS_API_KEY is required for ElevenLabs Discord voice.");
		if (this.voiceId.length === 0) throw new Error("An ElevenLabs voice id is required for Discord voice.");
		if (this.modelId.length === 0) throw new Error("An ElevenLabs model id is required for Discord voice.");

		const url = new URL(`${this.baseUrl}/v1/text-to-speech/${encodeURIComponent(this.voiceId)}/stream`);
		url.searchParams.set("output_format", this.outputFormat);
		const requestInit: RequestInit = {
			method: "POST",
			headers: {
				Accept: "application/octet-stream",
				"Content-Type": "application/json",
				"xi-api-key": this.apiKey,
			},
			body: JSON.stringify({
				text: prompt,
				model_id: this.modelId,
				voice_settings: { speed: this.speed },
			}),
		};
		if (options.signal !== undefined) requestInit.signal = options.signal;
		const response = await fetch(url, requestInit);
		if (!response.ok) {
			const body = await response.text().catch(() => "");
			throw new Error(`ElevenLabs TTS failed with ${response.status}: ${body.trim() || response.statusText}`);
		}
		const body = response.body;
		if (body === null) throw new Error("ElevenLabs TTS response did not include an audio stream.");
		const sampleRate = parseElevenLabsPcmSampleRate(this.outputFormat);
		const minFlushBytes = pcm16BytesForDuration(sampleRate, MIN_STREAM_FLUSH_MS);
		const maxFlushBytes = pcm16BytesForDuration(sampleRate, MAX_STREAM_FLUSH_MS);
		const reader = body.getReader();
		let remainder = Buffer.alloc(0);
		let pending = Buffer.alloc(0);
		const flushPending = async (force: boolean): Promise<void> => {
			while (pending.length >= minFlushBytes || (force && pending.length > 0)) {
				const targetBytes = force ? pending.length : Math.min(pending.length, maxFlushBytes);
				const usableBytes = targetBytes - (targetBytes % 2);
				if (usableBytes <= 0) return;
				const output = pending.subarray(0, usableBytes);
				pending = pending.subarray(usableBytes);
				await onAudio({ pcmBase64: output.toString("base64"), sampleRate });
			}
		};
		try {
			for (;;) {
				if (isAbortSignalAborted(options.signal)) break;
				const { done, value } = await reader.read();
				if (done) break;
				if (value === undefined || value.byteLength === 0) continue;
				let chunk = Buffer.from(value);
				if (remainder.length > 0) {
					chunk = Buffer.concat([remainder, chunk]);
					remainder = Buffer.alloc(0);
				}
				if (chunk.length % 2 !== 0) {
					remainder = chunk.subarray(chunk.length - 1);
					chunk = chunk.subarray(0, chunk.length - 1);
				}
				if (chunk.length === 0) continue;
				pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);
				await flushPending(false);
			}
			await flushPending(true);
			if (remainder.length > 0) {
				this.logger?.("warn", "elevenlabs_tts_odd_pcm_byte_discarded", { outputFormat: this.outputFormat });
			}
		} finally {
			if (isAbortSignalAborted(options.signal)) await reader.cancel().catch(() => undefined);
			reader.releaseLock();
		}
	}
}

function isAbortSignalAborted(signal: AbortSignal | undefined): boolean {
	return signal?.aborted === true;
}

export function parseElevenLabsPcmOutputFormat(value: string | undefined): ElevenLabsPcmOutputFormat | undefined {
	const normalized = value?.trim();
	if (
		normalized === "pcm_16000" ||
		normalized === "pcm_22050" ||
		normalized === "pcm_24000" ||
		normalized === "pcm_44100"
	) {
		return normalized;
	}
	return undefined;
}

export function parseElevenLabsPcmSampleRate(format: ElevenLabsPcmOutputFormat): number {
	return Number.parseInt(format.slice("pcm_".length), 10);
}

function normalizeSpeed(value: number | undefined): number {
	if (value === undefined) return DEFAULT_ELEVENLABS_SPEED;
	if (!Number.isFinite(value) || value <= 0) return DEFAULT_ELEVENLABS_SPEED;
	return value;
}

function pcm16BytesForDuration(sampleRate: number, durationMs: number): number {
	const bytes = Math.max(2, Math.floor((sampleRate * 2 * durationMs) / 1_000));
	return bytes - (bytes % 2);
}
