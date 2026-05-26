import { randomUUID } from "node:crypto";
import { access, appendFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { DiscordSubagentStore } from "@clanky/core";
import {
	type AgentSessionEvent,
	type AgentSessionRuntime,
	type CreateAgentSessionRuntimeFactory,
	CURRENT_SESSION_VERSION,
	createAgentSessionRuntime,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import { SerialRuntimeTurnQueue } from "./runtimeTurnQueue.ts";

export interface DiscordVoiceSubagentCoordinatorOptions {
	store: DiscordSubagentStore;
	createRuntime: CreateAgentSessionRuntimeFactory;
	agentDir: string;
	cwd: string;
	sessionDir: string;
	guildId: string;
	channelId: string;
	model: string;
	voice: string;
	reasoningEffort?: string;
	bridgeLogPath?: string;
}

export interface DiscordVoiceRealtimeTranscript {
	text: string;
	eventType: string;
}

export interface DiscordVoiceSpeakerTranscriptRecord {
	userId: string;
	displayName: string;
	text: string;
	eventType: string;
}

const VOICE_AGENT_KIND = "discord-voice";
const VOICE_WORKER_KIND = "voice-worker";
const VOICE_WORKER_TIMEOUT_MS = 120_000;
const MAX_TRANSCRIPT_TEXT_CHARS = 3000;
const MAX_TOOL_TEXT_CHARS = 4000;

export class DiscordVoiceSubagentCoordinator {
	private readonly store: DiscordSubagentStore;
	private readonly createRuntime: CreateAgentSessionRuntimeFactory;
	private readonly agentDir: string;
	private readonly cwd: string;
	private readonly sessionDir: string;
	private readonly guildId: string;
	private readonly channelId: string;
	private readonly model: string;
	private readonly voice: string;
	private readonly reasoningEffort: string | undefined;
	private readonly bridgeLogPath: string | undefined;
	private readonly voiceId: string;
	private readonly workerId: string;
	private readonly scopeId: string;
	private readonly voiceTranscript: SubagentTranscriptFile;
	private readonly workerQueue = new SerialRuntimeTurnQueue();
	private workerRuntime: AgentSessionRuntime | undefined;
	private stopped = false;

	constructor(options: DiscordVoiceSubagentCoordinatorOptions) {
		this.store = options.store;
		this.createRuntime = options.createRuntime;
		this.agentDir = options.agentDir;
		this.cwd = options.cwd;
		this.sessionDir = options.sessionDir;
		this.guildId = options.guildId;
		this.channelId = options.channelId;
		this.model = options.model;
		this.voice = options.voice;
		this.reasoningEffort = options.reasoningEffort;
		this.bridgeLogPath = options.bridgeLogPath;
		this.scopeId = `${options.guildId}:${options.channelId}`;
		this.voiceId = `discord-voice:${this.scopeId}`;
		this.workerId = `voice-worker:${this.scopeId}`;
		this.voiceTranscript = new SubagentTranscriptFile({
			cwd: options.cwd,
			sessionDir: options.sessionDir,
			filePrefix: "discord-voice",
		});
	}

	async start(): Promise<void> {
		this.stopped = false;
		const sessionFile = await this.voiceTranscript.ensure();
		await this.store.upsertSubagent({
			id: this.voiceId,
			kind: VOICE_AGENT_KIND,
			scopeId: this.scopeId,
			scopeName: this.voiceScopeName(),
			state: "running",
			activeConversationId: this.channelId,
			activeSummary: "connecting realtime voice session",
			sessionFile,
			pid: process.pid,
		});
		await this.voiceTranscript.append("system", this.voiceSessionStartedText());
	}

	async stop(): Promise<void> {
		this.stopped = true;
		await this.voiceTranscript.append("system", "Discord realtime voice session stopped.");
		await this.store.setSubagentState(this.voiceId, "stale", {
			activeConversationId: this.channelId,
			activeSummary: "voice bridge stopped",
			sessionFile: this.voiceTranscript.sessionFile,
		});
		const runtime = this.workerRuntime;
		const workerSessionFile = runtime?.session.sessionFile;
		this.workerRuntime = undefined;
		await runtime?.dispose();
		if (runtime !== undefined) {
			await this.store.setSubagentState(this.workerId, "stale", {
				activeConversationId: this.channelId,
				activeSummary: "voice worker stopped",
				...(workerSessionFile === undefined ? {} : { sessionFile: workerSessionFile }),
			});
		}
	}

	async markFailed(error: unknown): Promise<void> {
		const message = errorMessage(error);
		await this.voiceTranscript.append("system", `Discord realtime voice session failed: ${message}`);
		await this.store.setSubagentState(this.voiceId, "failed", {
			activeConversationId: this.channelId,
			activeSummary: "voice bridge failed",
			sessionFile: this.voiceTranscript.sessionFile,
			lastError: message,
		});
	}

	async updateStatus(activeSummary: string): Promise<void> {
		if (this.stopped) return;
		await this.store.setSubagentState(this.voiceId, "running", {
			activeConversationId: this.channelId,
			activeSummary,
			sessionFile: this.voiceTranscript.sessionFile,
		});
	}

	recordRealtimeTranscript(transcript: DiscordVoiceRealtimeTranscript): void {
		if (!isFinalTranscriptEvent(transcript.eventType)) return;
		const text = transcript.text.trim();
		if (text.length === 0) return;
		const role = transcript.eventType.startsWith("conversation.item.input_audio_transcription") ? "user" : "assistant";
		const body = role === "user" ? `Message from Discord voice:\n${text}` : text;
		void this.voiceTranscript
			.append(role, truncateText(body, MAX_TRANSCRIPT_TEXT_CHARS))
			.then(() =>
				this.updateStatus(
					role === "user" ? `heard: ${truncateOneLine(text, 80)}` : `speaking: ${truncateOneLine(text, 80)}`,
				),
			)
			.catch((error: unknown) => this.log(`voice-transcript-record-failed error=${errorMessage(error)}`));
	}

	recordSpeakerTranscript(transcript: DiscordVoiceSpeakerTranscriptRecord): void {
		if (!isFinalTranscriptEvent(transcript.eventType)) return;
		const text = transcript.text.trim();
		if (text.length === 0) return;
		const displayName = transcript.displayName.trim() || `User ${transcript.userId}`;
		const body = `Message from Discord voice (${displayName}, ${transcript.userId}):\n${text}`;
		void this.voiceTranscript
			.append("user", truncateText(body, MAX_TRANSCRIPT_TEXT_CHARS))
			.then(() => this.updateStatus(`heard ${displayName}: ${truncateOneLine(text, 80)}`))
			.catch((error: unknown) => this.log(`voice-speaker-transcript-record-failed error=${errorMessage(error)}`));
	}

	recordToolCall(name: string, argumentsJson: string): void {
		const text = [`tool call: ${name}`, argumentsJson.trim()].filter((line) => line.length > 0).join("\n");
		void this.voiceTranscript
			.append("tool", truncateText(text, MAX_TOOL_TEXT_CHARS))
			.then(() => this.updateStatus(`tool call: ${name}`))
			.catch((error: unknown) => this.log(`voice-tool-call-record-failed error=${errorMessage(error)}`));
	}

	recordToolResult(name: string, result: unknown): void {
		const text = `tool result: ${name}\n${formatToolResult(result)}`;
		void this.voiceTranscript
			.append("tool", truncateText(text, MAX_TOOL_TEXT_CHARS))
			.catch((error: unknown) => this.log(`voice-tool-result-record-failed error=${errorMessage(error)}`));
	}

	async askWorker(prompt: string): Promise<string> {
		const normalizedPrompt = prompt.trim();
		if (normalizedPrompt.length === 0) throw new Error("ask_pi requires prompt.");
		const runtime = await this.ensureWorkerRuntime();
		const request = buildVoiceWorkerPrompt(normalizedPrompt, {
			guildId: this.guildId,
			channelId: this.channelId,
		});
		return await this.workerQueue.enqueue(async () => {
			await this.store.setSubagentState(this.workerId, "running", {
				activeConversationId: this.channelId,
				activeSummary: `handling voice request: ${truncateOneLine(normalizedPrompt, 80)}`,
				...(runtime.session.sessionFile === undefined ? {} : { sessionFile: runtime.session.sessionFile }),
			});
			try {
				const text = await sendSubagentMessageAndWaitForAssistantText(runtime, request, VOICE_WORKER_TIMEOUT_MS);
				await this.store.setSubagentState(this.workerId, "idle", {
					activeConversationId: this.channelId,
					activeSummary: "idle",
					...(runtime.session.sessionFile === undefined ? {} : { sessionFile: runtime.session.sessionFile }),
				});
				return text;
			} catch (error) {
				const message = errorMessage(error);
				await this.store.setSubagentState(this.workerId, "failed", {
					activeConversationId: this.channelId,
					activeSummary: "failed while handling voice request",
					...(runtime.session.sessionFile === undefined ? {} : { sessionFile: runtime.session.sessionFile }),
					lastError: message,
				});
				throw error;
			}
		});
	}

	private async ensureWorkerRuntime(): Promise<AgentSessionRuntime> {
		if (this.workerRuntime !== undefined) return this.workerRuntime;
		const sessionManager = await this.createWorkerSessionManager();
		const runtime = await createAgentSessionRuntime(this.createRuntime, {
			cwd: this.cwd,
			agentDir: this.agentDir,
			sessionManager,
		});
		this.workerRuntime = runtime;
		await this.store.upsertSubagent({
			id: this.workerId,
			kind: VOICE_WORKER_KIND,
			scopeId: this.scopeId,
			scopeName: `${this.voiceScopeName()} worker`,
			state: "idle",
			activeConversationId: this.channelId,
			activeSummary: "worker runtime ready",
			...(runtime.session.sessionFile === undefined ? {} : { sessionFile: runtime.session.sessionFile }),
			pid: process.pid,
		});
		return runtime;
	}

	private async createWorkerSessionManager(): Promise<SessionManager> {
		const existing = await this.store.getSubagent(this.workerId);
		const sessionFile = existing?.sessionFile;
		if (sessionFile !== undefined && (await isReadableFile(sessionFile))) {
			try {
				return SessionManager.open(sessionFile, this.sessionDir, this.cwd);
			} catch (error) {
				this.log(
					`voice-worker-session-resume-failed worker=${this.workerId} file=${sessionFile} error=${errorMessage(error)}`,
				);
			}
		}
		return SessionManager.create(this.cwd, this.sessionDir);
	}

	private voiceScopeName(): string {
		return `Discord voice ${this.channelId}`;
	}

	private voiceSessionStartedText(): string {
		return [
			"Discord realtime voice session started.",
			`Guild: ${this.guildId}`,
			`Channel: ${this.channelId}`,
			`Model: ${this.model}`,
			`Voice: ${this.voice}`,
			...(this.reasoningEffort === undefined ? [] : [`Reasoning effort: ${this.reasoningEffort}`]),
		].join("\n");
	}

	private log(line: string): void {
		if (this.bridgeLogPath === undefined) return;
		appendFile(this.bridgeLogPath, `${new Date().toISOString()} ${line}\n`).catch((error: unknown) => {
			console.error(`discord-voice-subagent log failed: ${errorMessage(error)}`);
		});
	}
}

interface SubagentTranscriptFileOptions {
	cwd: string;
	sessionDir: string;
	filePrefix: string;
}

class SubagentTranscriptFile {
	private readonly cwd: string;
	private readonly sessionDir: string;
	private readonly filePrefix: string;
	private readonly sessionId: string;
	private readonly sessionTimestamp: string;
	private readonly ensurePromise: Promise<string>;
	private appendTail: Promise<void> = Promise.resolve();
	private nextEntryIndex = 1;
	private parentId: string | null = null;
	readonly sessionFile: string;

	constructor(options: SubagentTranscriptFileOptions) {
		this.cwd = options.cwd;
		this.sessionDir = options.sessionDir;
		this.filePrefix = options.filePrefix;
		this.sessionId = `${this.filePrefix}-${randomUUID()}`;
		this.sessionTimestamp = new Date().toISOString();
		this.sessionFile = join(this.sessionDir, `${this.sessionTimestamp.replace(/[:.]/g, "-")}_${this.sessionId}.jsonl`);
		this.ensurePromise = this.writeHeader();
	}

	async ensure(): Promise<string> {
		return await this.ensurePromise;
	}

	append(role: "user" | "assistant" | "tool" | "system", text: string): Promise<void> {
		this.appendTail = this.appendTail
			.catch(() => undefined)
			.then(async () => {
				await this.ensure();
				const id = `${this.filePrefix}-message-${this.nextEntryIndex}`;
				this.nextEntryIndex += 1;
				const entry = {
					type: "message",
					id,
					parentId: this.parentId,
					timestamp: new Date().toISOString(),
					message: {
						role,
						content: [{ type: "text", text }],
					},
				};
				this.parentId = id;
				await appendFile(this.sessionFile, `${JSON.stringify(entry)}\n`);
			});
		return this.appendTail;
	}

	private async writeHeader(): Promise<string> {
		await mkdir(this.sessionDir, { recursive: true, mode: 0o700 });
		const header = {
			type: "session",
			version: CURRENT_SESSION_VERSION,
			id: this.sessionId,
			timestamp: this.sessionTimestamp,
			cwd: this.cwd,
		};
		await writeFile(this.sessionFile, `${JSON.stringify(header)}\n`);
		return this.sessionFile;
	}
}

function buildVoiceWorkerPrompt(prompt: string, context: { guildId: string; channelId: string }): string {
	return [
		"You are a dedicated Clanky subagent handling durable or tool-heavy work delegated by the Discord realtime voice agent.",
		"You have Clanky's normal tools, skills, memory, and project context. Work independently so the main Clanky session stays unblocked.",
		"Return only the concise answer the voice agent should speak back into Discord unless the request explicitly needs more detail.",
		"",
		`Discord voice guild: ${context.guildId}`,
		`Discord voice channel: ${context.channelId}`,
		"",
		"Voice request:",
		"",
		prompt,
	].join("\n");
}

function sendSubagentMessageAndWaitForAssistantText(
	runtime: AgentSessionRuntime,
	message: string,
	timeoutMs: number,
): Promise<string> {
	return new Promise<string>((resolve, reject) => {
		let settled = false;
		const timer = setTimeout(() => {
			finish(undefined, new Error("Timed out waiting for voice worker subagent response."));
		}, timeoutMs);
		const unsubscribe = runtime.session.subscribe((event) => {
			const text = assistantText(event);
			if (text !== undefined) finish(text, undefined);
		});
		const finish = (text: string | undefined, error: Error | undefined) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			unsubscribe();
			if (error !== undefined) reject(error);
			else resolve(text ?? "");
		};
		runtime.session.sendUserMessage(message).catch((error: unknown) => {
			finish(undefined, error instanceof Error ? error : new Error(String(error)));
		});
	});
}

function assistantText(event: AgentSessionEvent): string | undefined {
	if (event.type !== "message_end" || event.message.role !== "assistant") return undefined;
	if (event.message.stopReason === "toolUse") return undefined;
	const text = event.message.content
		.filter((part) => part.type === "text")
		.map((part) => part.text)
		.join("\n")
		.trim();
	return text.length > 0 ? text : undefined;
}

async function isReadableFile(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

function isFinalTranscriptEvent(eventType: string): boolean {
	return eventType.endsWith(".completed") || eventType.endsWith(".done");
}

function formatToolResult(result: unknown): string {
	if (typeof result === "string") return truncateText(result, MAX_TOOL_TEXT_CHARS);
	try {
		return truncateText(JSON.stringify(result, null, 2), MAX_TOOL_TEXT_CHARS);
	} catch {
		return truncateText(String(result), MAX_TOOL_TEXT_CHARS);
	}
}

function truncateOneLine(text: string, maxLength: number): string {
	return truncateText(text.replace(/\s+/g, " ").trim(), maxLength);
}

function truncateText(text: string, maxLength: number): string {
	if (text.length <= maxLength) return text;
	if (maxLength <= 3) return text.slice(0, maxLength);
	return `${text.slice(0, maxLength - 3)}...`;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? (error.stack ?? error.message) : String(error);
}
