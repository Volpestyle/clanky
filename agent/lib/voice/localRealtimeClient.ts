import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type JsonRecord } from "./json.ts";
import type {
	OpenAiRealtimeClientOptions,
	OpenAiRealtimeConnectOptions,
	OpenAiRealtimeTranscript,
} from "./openAiRealtimeClient.ts";

export interface LocalRealtimeClientOptions extends Pick<OpenAiRealtimeClientOptions, "logger"> {
	asrCommand?: string;
	asrModelPath: string;
	asrLanguage?: string;
	audioSampleRate?: number;
	llmBaseUrl?: string;
	llmApiKey?: string;
	llmModel: string;
	ttsEngine?: "say" | "command";
	ttsCommand?: string;
	ttsVoice?: string;
	ttsSampleRate?: number;
}

interface ChatMessage {
	role: "system" | "user" | "assistant";
	content: string;
}

interface ExecTextResult {
	stdout: string;
	stderr: string;
}

const DEFAULT_ASR_COMMAND = "whisper-cli";
const DEFAULT_ASR_LANGUAGE = "en";
const DEFAULT_AUDIO_SAMPLE_RATE = 24_000;
const DEFAULT_LOCAL_LLM_BASE_URL = "http://127.0.0.1:11434/v1";
const DEFAULT_TTS_SAMPLE_RATE = 24_000;
const LOCAL_VOICE_MAX_HISTORY_MESSAGES = 12;

export class LocalRealtimeClient extends EventEmitter {
	readonly supportsInputVideoFrames = false;
	private readonly asrCommand: string;
	private readonly asrModelPath: string;
	private readonly asrLanguage: string;
	private readonly audioSampleRate: number;
	private readonly llmBaseUrl: string;
	private readonly llmApiKey: string | undefined;
	private readonly llmModel: string;
	private readonly ttsEngine: "say" | "command";
	private readonly ttsCommand: string | undefined;
	private readonly ttsVoice: string;
	private readonly ttsSampleRate: number;
	private readonly logger: LocalRealtimeClientOptions["logger"];
	private session: OpenAiRealtimeConnectOptions | undefined;
	private inputAudio = Buffer.alloc(0);
	private closed = false;
	private queue: Promise<void> = Promise.resolve();
	private history: ChatMessage[] = [];
	private warnedAboutVideoFrames = false;

	constructor(options: LocalRealtimeClientOptions) {
		super();
		this.asrCommand = options.asrCommand?.trim() || DEFAULT_ASR_COMMAND;
		this.asrModelPath = options.asrModelPath.trim();
		this.asrLanguage = options.asrLanguage?.trim() || DEFAULT_ASR_LANGUAGE;
		this.audioSampleRate = normalizeSampleRate(options.audioSampleRate, DEFAULT_AUDIO_SAMPLE_RATE);
		this.llmBaseUrl = options.llmBaseUrl?.trim() || DEFAULT_LOCAL_LLM_BASE_URL;
		this.llmApiKey = options.llmApiKey?.trim() || undefined;
		this.llmModel = options.llmModel.trim();
		this.ttsEngine = options.ttsEngine ?? "say";
		this.ttsCommand = options.ttsCommand?.trim() || undefined;
		this.ttsVoice = options.ttsVoice?.trim() || "Samantha";
		this.ttsSampleRate = normalizeSampleRate(options.ttsSampleRate, DEFAULT_TTS_SAMPLE_RATE);
		this.logger = options.logger;
	}

	async connect(options: OpenAiRealtimeConnectOptions): Promise<void> {
		if (this.asrModelPath.length === 0) throw new Error("CLANKY_VOICE_ASR_MODEL is required for local Discord voice.");
		if (this.llmModel.length === 0) throw new Error("CLANKY_VOICE_REALTIME_MODEL is required for local Discord voice.");
		this.session = {
			...options,
			responseOutputModality: options.responseOutputModality ?? "audio",
			inputAudioFormat: options.inputAudioFormat ?? "pcm16",
			outputAudioFormat: options.outputAudioFormat ?? "pcm16",
		};
		this.closed = false;
		this.emit("event", { type: "session.updated", provider: "local" } satisfies JsonRecord);
	}

	appendInputAudioPcm(audio: Buffer): void {
		if (audio.length === 0) return;
		this.inputAudio = Buffer.concat([this.inputAudio, audio]);
	}

	commitInputAudioBuffer(): void {
		// The local client processes the committed buffer when createAudioResponse()
		// arrives, matching the existing Realtime bridge's commit -> response flow.
	}

	cancelResponse(): void {
		this.inputAudio = Buffer.alloc(0);
	}

	createAudioResponse(): void {
		const audio = this.inputAudio;
		this.inputAudio = Buffer.alloc(0);
		if (audio.length === 0) return;
		this.enqueue(async () => {
			const text = await this.transcribe(audio);
			if (text.length === 0 || this.closed) return;
			const itemId = randomUUID();
			this.emitTranscript({
				text,
				itemId,
				eventType: "conversation.item.input_audio_transcription.completed",
			});
			const reply = await this.generateReply(text);
			await this.emitAssistantReply(reply);
		});
	}

	requestTextUtterance(text: string): void {
		const prompt = text.trim();
		if (prompt.length === 0) return;
		this.enqueue(async () => {
			await this.emitAssistantReply(prompt);
		});
	}

	appendInputVideoFrame(_input: { mimeType: string; dataBase64: string }): void {
		if (this.warnedAboutVideoFrames) return;
		this.warnedAboutVideoFrames = true;
		this.logger?.("warn", "local_realtime_video_frame_ignored", {
			reason: "The local voice provider currently accepts audio turns only.",
		});
	}

	sendFunctionCallOutput(_input: { callId: string; output: unknown }): void {
		this.logger?.("warn", "local_realtime_function_output_ignored", {
			reason: "The local voice provider does not currently perform native realtime tool calls.",
		});
	}

	async close(): Promise<void> {
		this.closed = true;
		this.inputAudio = Buffer.alloc(0);
		await this.queue.catch(() => {});
		this.emit("socket_closed", { code: 1000, reason: "local realtime closed" });
	}

	private enqueue(task: () => Promise<void>): void {
		this.queue = this.queue
			.then(task, task)
			.catch((error: unknown) => {
				const err = error instanceof Error ? error : new Error(String(error));
				this.logger?.("error", "local_realtime_error", { error: err.message });
				this.emit("socket_error", err);
			});
	}

	private async transcribe(pcm: Buffer): Promise<string> {
		const dir = await mkdtemp(join(tmpdir(), "clanky-local-voice-"));
		const wav = join(dir, "input.wav");
		try {
			await writeFile(wav, pcm16MonoWav(pcm, this.audioSampleRate));
			const result = await execFileText(
				this.asrCommand,
				[
					"--model",
					this.asrModelPath,
					"--file",
					wav,
					"--language",
					this.asrLanguage,
					"--no-timestamps",
					"--no-prints",
				],
				60_000,
			);
			return cleanWhisperOutput(result.stdout);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}

	private async generateReply(userText: string): Promise<string> {
		const session = this.session;
		if (session === undefined) throw new Error("Local realtime session is not connected.");
		const messages: ChatMessage[] = [
			{ role: "system", content: session.instructions },
			...this.history,
			{ role: "user", content: userText },
		];
		const reply = await requestOpenAiCompatibleChat({
			baseUrl: this.llmBaseUrl,
			apiKey: this.llmApiKey,
			model: this.llmModel,
			messages,
		});
		this.history.push({ role: "user", content: userText }, { role: "assistant", content: reply });
		while (this.history.length > LOCAL_VOICE_MAX_HISTORY_MESSAGES) this.history.shift();
		return reply;
	}

	private async emitAssistantReply(text: string): Promise<void> {
		const reply = text.trim();
		if (reply.length === 0 || this.closed) return;
		this.emitTranscript({
			text: reply,
			eventType: "response.output_text.done",
			itemId: randomUUID(),
		});
		if ((this.session?.responseOutputModality ?? "audio") !== "audio") return;
		const pcm = await this.synthesize(reply);
		if (pcm.length > 0 && !this.closed) this.emit("audio_delta", pcm.toString("base64"));
	}

	private async synthesize(text: string): Promise<Buffer> {
		if (this.ttsEngine === "command") {
			if (this.ttsCommand === undefined) throw new Error("CLANKY_VOICE_LOCAL_TTS_COMMAND is required when local TTS engine is command.");
			return await execShellWithStdin(this.ttsCommand, text, 60_000);
		}
		return await synthesizeWithSay(text, this.ttsVoice, this.ttsSampleRate);
	}

	private emitTranscript(transcript: OpenAiRealtimeTranscript): void {
		this.emit("transcript", transcript);
	}
}

async function requestOpenAiCompatibleChat(input: {
	baseUrl: string;
	apiKey?: string;
	model: string;
	messages: readonly ChatMessage[];
}): Promise<string> {
	const headers: Record<string, string> = { "content-type": "application/json" };
	if (input.apiKey !== undefined) headers.authorization = `Bearer ${input.apiKey}`;
	const response = await fetch(`${input.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
		method: "POST",
		headers,
		body: JSON.stringify({
			model: input.model,
			messages: input.messages,
			stream: false,
			temperature: 0.6,
			max_tokens: 180,
		}),
		signal: AbortSignal.timeout(120_000),
	});
	if (!response.ok) {
		throw new Error(`local voice LLM request failed: ${response.status} ${response.statusText}`);
	}
	const body: unknown = await response.json();
	const text = firstChoiceText(body).trim();
	if (text.length === 0) throw new Error("local voice LLM returned an empty reply");
	return text;
}

async function synthesizeWithSay(text: string, voice: string, sampleRate: number): Promise<Buffer> {
	const dir = await mkdtemp(join(tmpdir(), "clanky-local-tts-"));
	const aiff = join(dir, "speech.aiff");
	try {
		await execFileText("say", ["-v", voice, "-o", aiff, text], 60_000);
		return await execFileBuffer("ffmpeg", [
			"-nostdin",
			"-loglevel",
			"error",
			"-i",
			aiff,
			"-f",
			"s16le",
			"-ar",
			String(sampleRate),
			"-ac",
			"1",
			"pipe:1",
		], 60_000);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

async function execFileText(command: string, args: readonly string[], timeoutMs: number): Promise<ExecTextResult> {
	return await new Promise<ExecTextResult>((resolve, reject) => {
		execFile(command, [...args], { timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
			if (error !== null) {
				reject(new Error(`${command} failed: ${error.message}${stderr.length > 0 ? `: ${stderr}` : ""}`));
				return;
			}
			resolve({ stdout, stderr });
		});
	});
}

async function execFileBuffer(command: string, args: readonly string[], timeoutMs: number): Promise<Buffer> {
	return await new Promise<Buffer>((resolve, reject) => {
		const child = spawn(command, [...args], { stdio: ["ignore", "pipe", "pipe"] });
		const stdout: Buffer[] = [];
		const stderr: Buffer[] = [];
		const timer = setTimeout(() => {
			child.kill("SIGTERM");
			reject(new Error(`${command} timed out after ${timeoutMs}ms`));
		}, timeoutMs);
		child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
		child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
		child.once("error", (error) => {
			clearTimeout(timer);
			reject(error);
		});
		child.once("close", (code) => {
			clearTimeout(timer);
			if (code === 0) {
				resolve(Buffer.concat(stdout));
				return;
			}
			reject(new Error(`${command} exited with code ${code ?? "unknown"}: ${Buffer.concat(stderr).toString("utf8")}`));
		});
	});
}

async function execShellWithStdin(command: string, stdin: string, timeoutMs: number): Promise<Buffer> {
	return await new Promise<Buffer>((resolve, reject) => {
		const child = spawn("/bin/sh", ["-lc", command], { stdio: ["pipe", "pipe", "pipe"] });
		const stdout: Buffer[] = [];
		const stderr: Buffer[] = [];
		const timer = setTimeout(() => {
			child.kill("SIGTERM");
			reject(new Error(`local TTS command timed out after ${timeoutMs}ms`));
		}, timeoutMs);
		child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
		child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
		child.once("error", (error) => {
			clearTimeout(timer);
			reject(error);
		});
		child.once("close", (code) => {
			clearTimeout(timer);
			if (code === 0) {
				resolve(Buffer.concat(stdout));
				return;
			}
			reject(new Error(`local TTS command exited with code ${code ?? "unknown"}: ${Buffer.concat(stderr).toString("utf8")}`));
		});
		child.stdin.end(stdin);
	});
}

function pcm16MonoWav(pcm: Buffer, sampleRate: number): Buffer {
	const header = Buffer.alloc(44);
	header.write("RIFF", 0);
	header.writeUInt32LE(36 + pcm.length, 4);
	header.write("WAVE", 8);
	header.write("fmt ", 12);
	header.writeUInt32LE(16, 16);
	header.writeUInt16LE(1, 20);
	header.writeUInt16LE(1, 22);
	header.writeUInt32LE(sampleRate, 24);
	header.writeUInt32LE(sampleRate * 2, 28);
	header.writeUInt16LE(2, 32);
	header.writeUInt16LE(16, 34);
	header.write("data", 36);
	header.writeUInt32LE(pcm.length, 40);
	return Buffer.concat([header, pcm]);
}

function cleanWhisperOutput(output: string): string {
	return output
		.split(/\r?\n/u)
		.map((line) => line.replace(/^\s*\[[^\]]+\]\s*/u, "").trim())
		.filter((line) => line.length > 0)
		.join(" ")
		.replace(/\s+/gu, " ")
		.trim();
}

function firstChoiceText(value: unknown): string {
	if (!isRecord(value)) return "";
	const choices = Array.isArray(value.choices) ? value.choices : [];
	const first = choices[0];
	if (!isRecord(first)) return "";
	const message = first.message;
	if (isRecord(message) && typeof message.content === "string") return message.content;
	if (typeof first.text === "string") return first.text;
	return "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function normalizeSampleRate(value: number | undefined, fallback: number): number {
	if (value === undefined || !Number.isFinite(value)) return fallback;
	return Math.max(8_000, Math.min(48_000, Math.floor(value)));
}
