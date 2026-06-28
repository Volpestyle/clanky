import { Client } from "eve/client";
import type { ClientSession } from "eve/client";
import type { OpenAiRealtimeTranscript } from "./openAiRealtimeClient.ts";
import {
	isVoiceInputTranscript,
	type VoiceMemorySpeaker,
	type VoiceTranscriptSpeakerContext,
	type VoiceTranscriptSpeakerResolver,
} from "./memory.ts";

export interface VoiceEveSessionConfig {
	host: string;
	guildId: string;
	channelId: string;
	speaker?: VoiceMemorySpeaker;
	speakerUserIds?: string[];
	resolveSpeakerContext?: VoiceTranscriptSpeakerResolver;
}

export interface VoiceEveSessionStats {
	voiceEveSessionSendCount: number;
	voiceEveSessionErrorCount: number;
	voiceEveSessionSpokenResponseCount?: number;
}

export interface VoiceEveSessionTranscriptSource {
	on(event: "transcript", listener: (transcript: OpenAiRealtimeTranscript) => void): unknown;
	off?(event: "transcript", listener: (transcript: OpenAiRealtimeTranscript) => void): unknown;
}

export interface VoiceEveSessionResponse {
	result(): Promise<{ sessionId: string; message?: string | null }>;
}

export interface VoiceEveSessionHandle {
	send(message: string): Promise<VoiceEveSessionResponse>;
}

export interface BindVoiceEveSessionOptions {
	realtime: VoiceEveSessionTranscriptSource;
	config: VoiceEveSessionConfig;
	stats?: VoiceEveSessionStats;
	createSession?(host: string): VoiceEveSessionHandle;
	speakResponse?(message: string): Promise<void> | void;
	/** Fired once with the durability session id, so the owner can mirror it in a pane. */
	onSessionId?(sessionId: string): void;
}

export interface VoiceEveSessionBinding {
	dispose(): void;
}

export function bindVoiceEveSession(options: BindVoiceEveSessionOptions): VoiceEveSessionBinding {
	return new VoiceEveSessionBridge(options);
}

export function formatVoiceEvePrompt(transcript: OpenAiRealtimeTranscript, config: VoiceEveSessionConfig): string {
	const speakerLines = formatSpeakerLines(resolveVoiceEveSpeakerContext(transcript, config));
	return [
		"Discord voice conversation update:",
		"",
		"This is a silent durability turn for Clanky's live Discord voice call. Preserve continuity, update durable state when appropriate, and use tools/delegation only when the spoken request clearly needs real work. Do not post a visible Discord text message for ordinary conversation. Reply with exactly [SKIP] unless a concise spoken follow-up to the call is genuinely needed; non-skip text may be spoken back into voice.",
		"",
		"Voice context:",
		`- guildId: ${config.guildId}`,
		`- channelId: ${config.channelId}`,
		...speakerLines,
		`- transcriptItemId: ${transcript.itemId ?? "(none)"}`,
		"",
		"Newest voice transcript:",
		transcript.text.trim(),
	].join("\n");
}

function formatSpeakerLines(context: VoiceTranscriptSpeakerContext): string[] {
	if (context.speaker !== undefined) {
		return [
			`- speakerUserId: ${context.speaker.userId}`,
			...(context.speaker.userName === undefined ? [] : [`- speakerName: ${context.speaker.userName}`]),
		];
	}
	const speakerUserIds = uniqueSorted(context.speakerUserIds ?? []);
	if (speakerUserIds.length > 0) {
		return ["- speaker: multiple-or-unknown", `- speakerUserIds: ${speakerUserIds.join(", ")}`];
	}
	return ["- speaker: unknown"];
}

function resolveVoiceEveSpeakerContext(
	transcript: OpenAiRealtimeTranscript,
	config: VoiceEveSessionConfig,
): VoiceTranscriptSpeakerContext {
	const resolved = config.resolveSpeakerContext?.(transcript);
	if (resolved !== undefined) return resolved;
	return { speaker: config.speaker, speakerUserIds: config.speakerUserIds };
}

function uniqueSorted(values: readonly string[]): string[] {
	return [...new Set(values.map((value) => value.trim()).filter((value) => value.length > 0))].sort();
}

class VoiceEveSessionBridge implements VoiceEveSessionBinding {
	private readonly realtime: VoiceEveSessionTranscriptSource;
	private readonly config: VoiceEveSessionConfig;
	private readonly stats: VoiceEveSessionStats | undefined;
	private readonly createSession: (host: string) => VoiceEveSessionHandle;
	private readonly speakResponse: ((message: string) => Promise<void> | void) | undefined;
	private readonly onSessionId: ((sessionId: string) => void) | undefined;
	private readonly listener: (transcript: OpenAiRealtimeTranscript) => void;
	private session: VoiceEveSessionHandle | undefined;
	private sessionIdNotified = false;
	private queue: Promise<void> = Promise.resolve();
	private disposed = false;

	constructor(options: BindVoiceEveSessionOptions) {
		this.realtime = options.realtime;
		this.config = options.config;
		this.stats = options.stats;
		this.createSession = options.createSession ?? createClientSession;
		this.speakResponse = options.speakResponse;
		this.onSessionId = options.onSessionId;
		this.listener = (transcript) => this.enqueueTranscript(transcript);
		this.realtime.on("transcript", this.listener);
	}

	dispose(): void {
		this.disposed = true;
		this.realtime.off?.("transcript", this.listener);
	}

	private enqueueTranscript(transcript: OpenAiRealtimeTranscript): void {
		if (this.disposed || !isVoiceInputTranscript(transcript) || transcript.text.trim().length === 0) return;
		this.queue = this.queue.then(() => this.sendTranscript(transcript)).catch((error: unknown) => {
			if (this.stats !== undefined) this.stats.voiceEveSessionErrorCount += 1;
			console.error("voice eve session bridge failed:", error);
		});
	}

	private async sendTranscript(transcript: OpenAiRealtimeTranscript): Promise<void> {
		if (this.disposed) return;
		const session = this.session ?? this.createSession(this.config.host);
		this.session = session;
		const response = await session.send(formatVoiceEvePrompt(transcript, this.config));
		const result = await response.result();
		if (!this.sessionIdNotified && result.sessionId.length > 0) {
			this.sessionIdNotified = true;
			this.onSessionId?.(result.sessionId);
		}
		if (this.stats !== undefined) this.stats.voiceEveSessionSendCount += 1;
		const message = result.message?.trim();
		if (message !== undefined && message.length > 0 && !isSkipResponse(message)) {
			await this.speakResponse?.(message);
			if (this.stats !== undefined) {
				this.stats.voiceEveSessionSpokenResponseCount = (this.stats.voiceEveSessionSpokenResponseCount ?? 0) + 1;
			}
		}
	}
}

function createClientSession(host: string): VoiceEveSessionHandle {
	const session: ClientSession = new Client({ host }).session();
	return session;
}

function isSkipResponse(value: string): boolean {
	return /^\[SKIP\]$/i.test(value.trim());
}
