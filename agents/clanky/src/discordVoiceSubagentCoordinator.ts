import { randomUUID } from "node:crypto";
import { access, appendFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
	type ClankySubagentStore,
	type JsonRecord,
	maybeInjectWorkTrackerSkill,
	type SendSubagentMessageInput,
	type SendSubagentMessageResult,
	truncateText,
} from "@clanky/core";
import {
	type AgentSessionEvent,
	type AgentSessionRuntime,
	type CreateAgentSessionRuntimeFactory,
	CURRENT_SESSION_VERSION,
	createAgentSessionRuntime,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import type { ClankyThinkingLevel } from "./clankyDefaults.ts";
import { SerialRuntimeTurnQueue } from "./runtimeTurnQueue.ts";
import type {
	VoiceSupervisorDelegateHandle,
	VoiceSupervisorDelegateInput,
	VoiceSupervisorDelegateResult,
} from "./voiceSupervisorExtension.ts";

export interface DiscordVoiceSubagentCoordinatorOptions {
	store: ClankySubagentStore;
	createRuntime: CreateAgentSessionRuntimeFactory;
	createGeneralRuntime: CreateAgentSessionRuntimeFactory;
	agentDir: string;
	cwd: string;
	sessionDir: string;
	guildId: string;
	channelId: string;
	model: string;
	voice: string;
	env?: NodeJS.ProcessEnv;
	reasoningEffort?: string;
	voiceSupervisorDelegate?: VoiceSupervisorDelegateHandle;
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
const VOICE_GENERAL_SUBAGENT_KIND = "voice-general";
const MAX_TRANSCRIPT_TEXT_CHARS = 3000;
const MAX_TOOL_TEXT_CHARS = 4000;

interface VoiceGeneralSubagentRuntimeEntry {
	runtime: AgentSessionRuntime;
	queue: SerialRuntimeTurnQueue;
	workerId: string;
	workerKey: string;
}

export class DiscordVoiceSubagentCoordinator {
	private readonly store: ClankySubagentStore;
	private readonly createRuntime: CreateAgentSessionRuntimeFactory;
	private readonly createGeneralRuntime: CreateAgentSessionRuntimeFactory;
	private readonly agentDir: string;
	private readonly cwd: string;
	private readonly sessionDir: string;
	private readonly guildId: string;
	private readonly channelId: string;
	private readonly model: string;
	private readonly voice: string;
	private readonly env: NodeJS.ProcessEnv;
	private readonly reasoningEffort: string | undefined;
	private readonly voiceSupervisorDelegate: VoiceSupervisorDelegateHandle | undefined;
	private readonly bridgeLogPath: string | undefined;
	private readonly voiceId: string;
	private readonly workerId: string;
	private readonly scopeId: string;
	private readonly voiceTranscript: SubagentTranscriptFile;
	private readonly workerQueue = new SerialRuntimeTurnQueue();
	private readonly generalRuntimes = new Map<string, VoiceGeneralSubagentRuntimeEntry>();
	private workerRuntime: AgentSessionRuntime | undefined;
	private workerRuntimePromise: Promise<AgentSessionRuntime> | undefined;
	private readonly delegateToSubagent = async (
		input: VoiceSupervisorDelegateInput,
	): Promise<VoiceSupervisorDelegateResult> => await this.delegateToGeneralSubagent(input);
	private stopped = false;

	constructor(options: DiscordVoiceSubagentCoordinatorOptions) {
		this.store = options.store;
		this.createRuntime = options.createRuntime;
		this.createGeneralRuntime = options.createGeneralRuntime;
		this.agentDir = options.agentDir;
		this.cwd = options.cwd;
		this.sessionDir = options.sessionDir;
		this.guildId = options.guildId;
		this.channelId = options.channelId;
		this.model = options.model;
		this.voice = options.voice;
		this.env = options.env ?? process.env;
		this.reasoningEffort = options.reasoningEffort;
		this.voiceSupervisorDelegate = options.voiceSupervisorDelegate;
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
		if (this.voiceSupervisorDelegate !== undefined) {
			this.voiceSupervisorDelegate.delegateToSubagent = this.delegateToSubagent;
		}
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
			...(this.reasoningEffort === undefined ? {} : { thinkingLevel: this.reasoningEffort }),
			pid: process.pid,
		});
		await this.voiceTranscript.append("system", this.voiceSessionStartedText());
	}

	prewarmWorker(): void {
		void this.ensureWorkerRuntime()
			.then((runtime) =>
				this.store.setSubagentState(this.workerId, "idle", {
					activeConversationId: this.channelId,
					activeSummary: "prewarmed voice supervisor ready",
					...(runtime.session.sessionFile === undefined ? {} : { sessionFile: runtime.session.sessionFile }),
					thinkingLevel: runtime.session.thinkingLevel,
				}),
			)
			.catch((error: unknown) => {
				if (this.stopped) return;
				this.log(`voice-worker-prewarm-failed worker=${this.workerId} error=${errorMessage(error)}`);
			});
	}

	status(): JsonRecord {
		return {
			scopeId: this.scopeId,
			voiceSubagentId: this.voiceId,
			workerSubagentId: this.workerId,
			workerRuntimeReady: this.workerRuntime !== undefined,
			workerRuntimeStarting: this.workerRuntimePromise !== undefined,
			workerQueueBusy: this.workerQueue.isBusy(),
			generalSubagentCount: this.generalRuntimes.size,
			generalSubagents: [...this.generalRuntimes.values()].map((entry) => ({
				id: entry.workerId,
				workerKey: entry.workerKey,
				queueBusy: entry.queue.isBusy(),
				sessionId: entry.runtime.session.sessionId,
				sessionFile: entry.runtime.session.sessionFile,
			})),
		};
	}

	async stop(): Promise<void> {
		this.stopped = true;
		if (this.voiceSupervisorDelegate?.delegateToSubagent === this.delegateToSubagent) {
			delete this.voiceSupervisorDelegate.delegateToSubagent;
		}
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
		for (const entry of this.generalRuntimes.values()) {
			const sessionFile = entry.runtime.session.sessionFile;
			await entry.runtime.dispose();
			await this.store.setSubagentState(entry.workerId, "stale", {
				activeConversationId: this.channelId,
				activeSummary: "voice general subagent stopped",
				...(sessionFile === undefined ? {} : { sessionFile }),
			});
		}
		this.generalRuntimes.clear();
	}

	setThinkingLevel(level: ClankyThinkingLevel): number {
		let updated = 0;
		if (this.workerRuntime !== undefined) {
			this.workerRuntime.session.setThinkingLevel(level);
			updated += 1;
		}
		for (const entry of this.generalRuntimes.values()) {
			entry.runtime.session.setThinkingLevel(level);
			updated += 1;
		}
		return updated;
	}

	async sendInteractiveMessage(input: SendSubagentMessageInput): Promise<SendSubagentMessageResult | undefined> {
		const subagentId = input.id.trim();
		const text = input.text.trim();
		if (subagentId.length === 0 || text.length === 0) {
			return { accepted: false, message: "Subagent id and message are required." };
		}
		if (subagentId === this.voiceId) {
			return {
				accepted: false,
				message: "The live voice transcript is read-only. Open the voice worker subagent to chat with Pi.",
			};
		}
		if (subagentId === this.workerId) {
			const runtime = await this.ensureWorkerRuntime();
			return await this.workerQueue.enqueue(async () => this.promptRuntimeFromTui(subagentId, runtime, text, "idle"));
		}
		const entry = this.generalRuntimes.get(subagentId);
		if (entry !== undefined) {
			return await entry.queue.enqueue(async () =>
				this.promptRuntimeFromTui(subagentId, entry.runtime, text, `completed TUI chat with ${entry.workerKey}`),
			);
		}
		if (subagentId.startsWith(`voice-general:${this.scopeId}:`)) {
			return {
				accepted: false,
				message: "That voice general subagent is not active in this Clanky process.",
			};
		}
		if (
			subagentId.startsWith(`discord-voice:${this.scopeId}`) ||
			subagentId.startsWith(`voice-worker:${this.scopeId}`)
		) {
			return {
				accepted: false,
				message: "That voice subagent runtime is not active in this Clanky process.",
			};
		}
		return undefined;
	}

	private async promptRuntimeFromTui(
		subagentId: string,
		runtime: AgentSessionRuntime,
		text: string,
		idleSummary: string,
	): Promise<SendSubagentMessageResult> {
		const mode = runtime.session.isStreaming ? "followUp" : "start";
		if (mode === "start") {
			await this.store.setSubagentState(subagentId, "running", {
				activeConversationId: this.channelId,
				activeSummary: `chatting from TUI: ${truncateOneLine(text, 80)}`,
				...(runtime.session.sessionFile === undefined ? {} : { sessionFile: runtime.session.sessionFile }),
				thinkingLevel: runtime.session.thinkingLevel,
			});
		}
		try {
			await runtime.session.prompt(text, {
				source: "extension",
				streamingBehavior: "followUp",
			});
			if (mode === "start") {
				await this.store.setSubagentState(subagentId, "idle", {
					activeConversationId: this.channelId,
					activeSummary: idleSummary,
					...(runtime.session.sessionFile === undefined ? {} : { sessionFile: runtime.session.sessionFile }),
					thinkingLevel: runtime.session.thinkingLevel,
				});
			}
			return { accepted: true, mode, sessionId: runtime.session.sessionId };
		} catch (error) {
			const message = errorMessage(error);
			await this.store.setSubagentState(subagentId, "failed", {
				activeConversationId: this.channelId,
				activeSummary: "failed while handling TUI chat",
				...(runtime.session.sessionFile === undefined ? {} : { sessionFile: runtime.session.sessionFile }),
				thinkingLevel: runtime.session.thinkingLevel,
				lastError: message,
			});
			return { accepted: false, message };
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
		const request = maybeInjectWorkTrackerSkill(
			buildVoiceWorkerPrompt(normalizedPrompt, {
				guildId: this.guildId,
				channelId: this.channelId,
			}),
			this.env,
		);
		return await this.workerQueue.enqueue(async () => {
			await this.store.setSubagentState(this.workerId, "running", {
				activeConversationId: this.channelId,
				activeSummary: `handling voice request: ${truncateOneLine(normalizedPrompt, 80)}`,
				...(runtime.session.sessionFile === undefined ? {} : { sessionFile: runtime.session.sessionFile }),
			});
			try {
				const text = await sendSubagentMessageAndWaitForAssistantText(runtime, request);
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
		if (this.workerRuntimePromise !== undefined) return await this.workerRuntimePromise;
		const promise = this.createWorkerRuntime();
		this.workerRuntimePromise = promise;
		try {
			return await promise;
		} finally {
			if (this.workerRuntimePromise === promise) this.workerRuntimePromise = undefined;
		}
	}

	private async createWorkerRuntime(): Promise<AgentSessionRuntime> {
		const sessionManager = await this.createWorkerSessionManager();
		const runtime = await createAgentSessionRuntime(this.createRuntime, {
			cwd: this.cwd,
			agentDir: this.agentDir,
			sessionManager,
		});
		if (this.stopped) {
			await runtime.dispose();
			throw new Error("voice worker stopped during startup");
		}
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
			thinkingLevel: runtime.session.thinkingLevel,
			pid: process.pid,
		});
		return runtime;
	}

	private async delegateToGeneralSubagent(input: VoiceSupervisorDelegateInput): Promise<VoiceSupervisorDelegateResult> {
		const title = input.title.trim();
		const prompt = input.prompt.trim();
		if (title.length === 0) throw new Error("voice_delegate_to_subagent requires a non-empty title.");
		if (prompt.length === 0) throw new Error("voice_delegate_to_subagent requires a non-empty prompt.");
		const workerKey = normalizeGeneralSubagentWorkerKey(input.workerKey ?? title);
		const workerId = `voice-general:${this.scopeId}:${workerKey}`;
		const queuedAt = new Date().toISOString();
		const entry = await this.ensureGeneralSubagentRuntime(workerId, workerKey, title);
		return await entry.queue.enqueue(async () => {
			await this.store.setSubagentState(workerId, "running", {
				activeConversationId: this.channelId,
				activeSummary: `voice delegated: ${truncateOneLine(title, 80)}`,
				...(entry.runtime.session.sessionFile === undefined ? {} : { sessionFile: entry.runtime.session.sessionFile }),
			});
			try {
				const request = maybeInjectWorkTrackerSkill(
					buildGeneralSubagentPrompt(input, {
						guildId: this.guildId,
						channelId: this.channelId,
						scopeId: this.scopeId,
						workerId,
						workerKey,
					}),
					this.env,
				);
				const response = await sendSubagentMessageAndWaitForAssistantText(entry.runtime, request);
				await this.store.setSubagentState(workerId, "idle", {
					activeConversationId: this.channelId,
					activeSummary: `completed: ${truncateOneLine(title, 80)}`,
					...(entry.runtime.session.sessionFile === undefined
						? {}
						: { sessionFile: entry.runtime.session.sessionFile }),
				});
				return {
					delegated: true,
					subagentId: workerId,
					kind: VOICE_GENERAL_SUBAGENT_KIND,
					title,
					queuedAt,
					sessionId: entry.runtime.session.sessionId,
					...(entry.runtime.session.sessionFile === undefined
						? {}
						: { sessionFile: entry.runtime.session.sessionFile }),
					response,
				};
			} catch (error) {
				const message = errorMessage(error);
				await this.store.setSubagentState(workerId, "failed", {
					activeConversationId: this.channelId,
					activeSummary: `failed: ${truncateOneLine(title, 80)}`,
					...(entry.runtime.session.sessionFile === undefined
						? {}
						: { sessionFile: entry.runtime.session.sessionFile }),
					lastError: message,
				});
				return {
					delegated: false,
					subagentId: workerId,
					kind: VOICE_GENERAL_SUBAGENT_KIND,
					title,
					queuedAt,
					sessionId: entry.runtime.session.sessionId,
					...(entry.runtime.session.sessionFile === undefined
						? {}
						: { sessionFile: entry.runtime.session.sessionFile }),
					error: message,
				};
			}
		});
	}

	private async ensureGeneralSubagentRuntime(
		workerId: string,
		workerKey: string,
		title: string,
	): Promise<VoiceGeneralSubagentRuntimeEntry> {
		const existing = this.generalRuntimes.get(workerId);
		if (existing !== undefined) return existing;
		const sessionManager = await this.createGeneralSessionManager(workerId);
		const runtime = await createAgentSessionRuntime(this.createGeneralRuntime, {
			cwd: this.cwd,
			agentDir: this.agentDir,
			sessionManager,
		});
		if (this.stopped) {
			await runtime.dispose();
			throw new Error("voice general subagent stopped during startup");
		}
		const entry = {
			runtime,
			queue: new SerialRuntimeTurnQueue(),
			workerId,
			workerKey,
		};
		this.generalRuntimes.set(workerId, entry);
		await this.store.upsertSubagent({
			id: workerId,
			kind: VOICE_GENERAL_SUBAGENT_KIND,
			scopeId: this.scopeId,
			scopeName: `${this.voiceScopeName()} general ${workerKey}`,
			state: "idle",
			activeConversationId: this.channelId,
			activeSummary: `ready for voice-delegated work: ${truncateOneLine(title, 80)}`,
			...(runtime.session.sessionFile === undefined ? {} : { sessionFile: runtime.session.sessionFile }),
			thinkingLevel: runtime.session.thinkingLevel,
			pid: process.pid,
		});
		return entry;
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

	private async createGeneralSessionManager(workerId: string): Promise<SessionManager> {
		const existing = await this.store.getSubagent(workerId);
		const sessionFile = existing?.sessionFile;
		if (sessionFile !== undefined && (await isReadableFile(sessionFile))) {
			try {
				return SessionManager.open(sessionFile, this.sessionDir, this.cwd);
			} catch (error) {
				this.log(
					`voice-general-session-resume-failed worker=${workerId} file=${sessionFile} error=${errorMessage(error)}`,
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
		"You are Clanky's voice supervisor worker for the active Discord voice session.",
		"The realtime voice agent owns live speech, interruption, and media; the main Clanky agent remains the foreground owner.",
		"Use normal Clanky tools plus voice_delegate_to_subagent for bounded helper work. Use delegate_to_main_worker when work should move to the foreground.",
		"Use main_agent_cancel only when the user explicitly asks to stop, cancel, or redirect main foreground work.",
		"Return only the concise answer the voice agent should speak unless the request explicitly needs detail.",
		"",
		`Discord voice guild: ${context.guildId}`,
		`Discord voice channel: ${context.channelId}`,
		"",
		"Voice request:",
		"",
		prompt,
	].join("\n");
}

function buildGeneralSubagentPrompt(
	input: VoiceSupervisorDelegateInput,
	context: {
		guildId: string;
		channelId: string;
		scopeId: string;
		workerId: string;
		workerKey: string;
	},
): string {
	return [
		"You are a general-purpose Clanky subagent spawned by the privileged Discord voice supervisor.",
		"You have normal Clanky tools, skills, memory, and project context, but you are not the main foreground agent or the live voice agent.",
		"You cannot spawn child subagents. Use main_agent_activity, subagent_status, subagent_message, main_session_context, or delegate_to_main_worker when those tools fit.",
		"Use main_agent_cancel only when the user explicitly asks to stop, cancel, or redirect main foreground work.",
		"Work independently, return a clear result to the voice supervisor, and keep the response concise enough to summarize in voice.",
		"",
		`Title: ${input.title.trim()}`,
		...(input.reason === undefined ? [] : [`Reason: ${input.reason.trim()}`]),
		`Discord voice guild: ${context.guildId}`,
		`Discord voice channel: ${context.channelId}`,
		`Voice scope: ${context.scopeId}`,
		`Subagent id: ${context.workerId}`,
		`Subagent key: ${context.workerKey}`,
		"",
		"Task:",
		"",
		input.prompt.trim(),
	].join("\n");
}

function normalizeGeneralSubagentWorkerKey(value: string): string {
	const normalized = value
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 48);
	return normalized.length > 0 ? normalized : randomUUID();
}

function sendSubagentMessageAndWaitForAssistantText(runtime: AgentSessionRuntime, message: string): Promise<string> {
	return new Promise<string>((resolve, reject) => {
		let settled = false;
		const unsubscribe = runtime.session.subscribe((event) => {
			const terminalError = assistantTerminalError(event);
			if (terminalError !== undefined) {
				finish(undefined, terminalError);
				return;
			}
			const text = assistantText(event);
			if (text !== undefined) finish(text, undefined);
		});
		const finish = (text: string | undefined, error: Error | undefined) => {
			if (settled) return;
			settled = true;
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

function assistantTerminalError(event: AgentSessionEvent): Error | undefined {
	if (event.type !== "message_end" || event.message.role !== "assistant") return undefined;
	if (event.message.stopReason !== "aborted" && event.message.stopReason !== "error") return undefined;
	const message = event.message.errorMessage ?? `Voice subagent response ${event.message.stopReason}.`;
	return new Error(message);
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

function errorMessage(error: unknown): string {
	return error instanceof Error ? (error.stack ?? error.message) : String(error);
}
