import { access, appendFile } from "node:fs/promises";
import type {
	ChatInboxAttachment,
	ChatInboxMessage,
	ClankySubagentKind,
	ClankySubagentStore,
	SendSubagentMessageInput,
	SendSubagentMessageResult,
} from "@clanky/core";
import {
	type AgentSessionEvent,
	type AgentSessionRuntime,
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionRuntime,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import type {
	DiscordAcceptanceReason,
	DiscordInboundConversation,
	DiscordInboundMessage,
} from "./agentDiscordGateway.ts";
import { withChatTypingIndicator } from "./chatTyping.ts";
import type { ClankyThinkingLevel } from "./clankyDefaults.ts";

interface DiscordMessageSender {
	sendMessage(input: {
		conversation: DiscordInboundConversation;
		replyToExternalMessageId: string;
		text: string;
	}): Promise<{ externalMessageId: string }>;
	sendTyping?(input: { conversation: DiscordInboundConversation }): Promise<void>;
}

interface DiscordWorkerTarget {
	workerId: string;
	kind: ClankySubagentKind;
	scopeId: string;
	scopeName?: string;
}

interface DiscordSubagentRuntimeEntry {
	runtime: AgentSessionRuntime;
	workerId: string;
}

export interface DiscordSubagentResponseSentEvent {
	message: ChatInboxMessage;
	sentExternalMessageId: string;
	text: string;
}

type DiscordSubagentResponseObserver = (event: DiscordSubagentResponseSentEvent) => void;

const DISCORD_OPERATOR_SKILL_NAME = "clanky-discord-operator";

export interface DiscordSubagentCoordinatorOptions {
	provider: DiscordMessageSender;
	store: ClankySubagentStore;
	mainRuntime: AgentSessionRuntime;
	createRuntime: CreateAgentSessionRuntimeFactory;
	agentDir: string;
	cwd: string;
	sessionDir: string;
	bridgeLogPath?: string;
}

export class DiscordSubagentCoordinator {
	private readonly provider: DiscordMessageSender;
	private readonly store: ClankySubagentStore;
	private readonly mainRuntime: AgentSessionRuntime;
	private readonly createRuntime: CreateAgentSessionRuntimeFactory;
	private readonly agentDir: string;
	private readonly cwd: string;
	private readonly sessionDir: string;
	private readonly bridgeLogPath: string | undefined;
	private readonly runtimes = new Map<string, DiscordSubagentRuntimeEntry>();
	private readonly pumpPromises = new Map<string, Promise<void>>();
	private readonly pumpWakeups = new Set<string>();
	private responseObserver: DiscordSubagentResponseObserver | undefined;
	private stopped = false;

	constructor(options: DiscordSubagentCoordinatorOptions) {
		this.provider = options.provider;
		this.store = options.store;
		this.mainRuntime = options.mainRuntime;
		this.createRuntime = options.createRuntime;
		this.agentDir = options.agentDir;
		this.cwd = options.cwd;
		this.sessionDir = options.sessionDir;
		this.bridgeLogPath = options.bridgeLogPath;
	}

	setResponseObserver(observer: DiscordSubagentResponseObserver | undefined): void {
		this.responseObserver = observer;
	}

	async start(): Promise<void> {
		this.stopped = false;
		const queuedWorkerIds = await this.store.listChatWorkersWithQueuedMessages();
		for (const workerId of queuedWorkerIds) this.schedulePump(workerId);
	}

	async stop(): Promise<void> {
		this.stopped = true;
		await Promise.allSettled([...this.pumpPromises.values()]);
		await Promise.all([...this.runtimes.values()].map((entry) => entry.runtime.dispose()));
		this.runtimes.clear();
		this.pumpWakeups.clear();
	}

	setThinkingLevel(level: ClankyThinkingLevel): number {
		let updated = 0;
		for (const { runtime } of this.runtimes.values()) {
			runtime.session.setThinkingLevel(level);
			updated += 1;
		}
		return updated;
	}

	async sendInteractiveMessage(input: SendSubagentMessageInput): Promise<SendSubagentMessageResult | undefined> {
		const workerId = input.id.trim();
		const text = input.text.trim();
		if (workerId.length === 0 || text.length === 0) {
			return { accepted: false, message: "Subagent id and message are required." };
		}
		const summary = await this.store.getSubagent(workerId);
		if (summary === undefined || !summary.kind.startsWith("discord-")) return undefined;
		const runtime = await this.ensureRuntimeForSummary(summary);
		const mode = runtime.session.isStreaming ? "followUp" : "start";
		if (mode === "start") {
			await this.store.setSubagentState(workerId, "running", {
				...(summary.activeConversationId === undefined ? {} : { activeConversationId: summary.activeConversationId }),
				activeSummary: `chatting from TUI: ${truncateOneLine(text, 80)}`,
				...sessionFileDetails(runtime),
				thinkingLevel: runtime.session.thinkingLevel,
			});
		}
		try {
			await runtime.session.prompt(text, {
				source: "extension",
				streamingBehavior: "followUp",
			});
			if (mode === "start") {
				await this.store.setSubagentState(workerId, "idle", {
					...(summary.activeConversationId === undefined ? {} : { activeConversationId: summary.activeConversationId }),
					activeSummary: "idle",
					...sessionFileDetails(runtime),
					thinkingLevel: runtime.session.thinkingLevel,
				});
			}
			return { accepted: true, mode, sessionId: runtime.session.sessionId };
		} catch (error) {
			const message = errorMessage(error);
			await this.store.setSubagentState(workerId, "failed", {
				...(summary.activeConversationId === undefined ? {} : { activeConversationId: summary.activeConversationId }),
				activeSummary: "failed while handling TUI chat",
				...sessionFileDetails(runtime),
				thinkingLevel: runtime.session.thinkingLevel,
				lastError: message,
			});
			return { accepted: false, message };
		}
	}

	async enqueue(message: DiscordInboundMessage, acceptanceReason: DiscordAcceptanceReason): Promise<void> {
		const target = resolveDiscordWorkerTarget(message);
		await this.store.enqueueChatMessage({
			workerId: target.workerId,
			kind: target.kind,
			scopeId: target.scopeId,
			...(target.scopeName === undefined ? {} : { scopeName: target.scopeName }),
			platform: "discord",
			...(message.conversation.serverId === undefined ? {} : { serverId: message.conversation.serverId }),
			conversationId: message.conversation.id,
			...(message.conversation.displayName === undefined ? {} : { conversationName: message.conversation.displayName }),
			conversationKind: message.conversation.kind,
			...(message.conversation.threadId === undefined ? {} : { conversationThreadId: message.conversation.threadId }),
			...(message.conversation.parentId === undefined ? {} : { conversationParentId: message.conversation.parentId }),
			senderId: message.sender.id,
			...(message.sender.displayName === undefined && message.sender.username === undefined
				? {}
				: { senderName: message.sender.displayName ?? message.sender.username }),
			externalMessageId: message.externalMessageId,
			...(message.replyToExternalMessageId === undefined
				? {}
				: { replyToExternalMessageId: message.replyToExternalMessageId }),
			acceptanceReason,
			text: message.text,
			attachments: message.attachments,
			priority: priorityForAcceptanceReason(acceptanceReason),
		});
		this.schedulePump(target.workerId);
	}

	private schedulePump(workerId: string): void {
		if (this.stopped) return;
		if (this.pumpPromises.has(workerId)) {
			this.pumpWakeups.add(workerId);
			return;
		}
		const promise = this.pump(workerId)
			.catch((error: unknown) => {
				this.log(`subagent-pump-error worker=${workerId} error=${errorMessage(error)}`);
			})
			.finally(() => {
				this.pumpPromises.delete(workerId);
				if (this.pumpWakeups.delete(workerId) && !this.stopped) this.schedulePump(workerId);
			});
		this.pumpPromises.set(workerId, promise);
	}

	private async pump(workerId: string): Promise<void> {
		while (!this.stopped) {
			const message = await this.store.claimNextChatMessage(workerId);
			if (message === undefined) {
				const depth = await this.store.chatQueueDepth(workerId);
				if (depth === 0) {
					const runtime = this.runtimes.get(workerId)?.runtime;
					await this.store.setSubagentState(workerId, "idle", {
						activeSummary: "idle",
						...sessionFileDetails(runtime),
					});
				}
				if (this.pumpWakeups.delete(workerId)) continue;
				break;
			}
			this.pumpWakeups.delete(workerId);
			await this.processMessage(message);
		}
	}

	private async processMessage(message: ChatInboxMessage): Promise<void> {
		const runtime = await this.ensureRuntime(message);
		const activeSummary = `replying to ${message.senderName ?? message.senderId} in ${message.conversationName ?? message.conversationId}`;
		await this.store.setSubagentState(message.workerId, "running", {
			activeConversationId: message.conversationId,
			activeSummary,
			...(runtime.session.sessionFile === undefined ? {} : { sessionFile: runtime.session.sessionFile }),
		});
		const conversation = inboxConversation(message);
		try {
			const replyText = await withChatTypingIndicator(
				this.provider,
				conversation,
				async () => runSubagentTurn(runtime, buildDiscordSubagentPrompt(message, this.mainStatusText())),
				{
					onError: (error) =>
						this.log(
							`typing-failed worker=${message.workerId} ext=${message.externalMessageId} error=${errorMessage(error)}`,
						),
				},
			);
			await this.store.setSubagentState(message.workerId, "running", {
				activeConversationId: message.conversationId,
				activeSummary,
				...sessionFileDetails(runtime),
			});
			if (replyText === undefined || isDiscordSkipReplyText(replyText)) {
				await this.store.completeChatMessage(message.id, undefined);
				return;
			}
			const sent = await this.provider.sendMessage({
				conversation,
				replyToExternalMessageId: message.externalMessageId,
				text: replyText,
			});
			this.responseObserver?.({ message, sentExternalMessageId: sent.externalMessageId, text: replyText });
			await this.store.completeChatMessage(message.id, sent.externalMessageId);
		} catch (error) {
			const messageText = errorMessage(error);
			await this.store.failChatMessage(message.id, messageText);
			await this.store.setSubagentState(message.workerId, "failed", {
				activeConversationId: message.conversationId,
				activeSummary: "failed while replying to Discord",
				...(runtime.session.sessionFile === undefined ? {} : { sessionFile: runtime.session.sessionFile }),
				lastError: messageText,
			});
		}
	}

	private async ensureRuntime(message: ChatInboxMessage): Promise<AgentSessionRuntime> {
		const existing = this.runtimes.get(message.workerId);
		if (existing !== undefined) return existing.runtime;
		const runtime = await this.createRuntimeForSubagent({
			id: message.workerId,
			kind: message.kind,
			scopeId: message.scopeId,
			...(message.scopeName === undefined ? {} : { scopeName: message.scopeName }),
		});
		await this.store.upsertSubagent({
			id: message.workerId,
			kind: message.kind,
			scopeId: message.scopeId,
			...(message.scopeName === undefined ? {} : { scopeName: message.scopeName }),
			state: "queued",
			...(runtime.session.sessionFile === undefined ? {} : { sessionFile: runtime.session.sessionFile }),
			thinkingLevel: runtime.session.thinkingLevel,
			pid: process.pid,
			activeSummary: "worker runtime ready",
		});
		return runtime;
	}

	private async ensureRuntimeForSummary(summary: {
		id: string;
		kind: ClankySubagentKind;
		scopeId: string;
		scopeName?: string;
	}): Promise<AgentSessionRuntime> {
		const existing = this.runtimes.get(summary.id);
		if (existing !== undefined) return existing.runtime;
		const runtime = await this.createRuntimeForSubagent(summary);
		await this.store.upsertSubagent({
			id: summary.id,
			kind: summary.kind,
			scopeId: summary.scopeId,
			...(summary.scopeName === undefined ? {} : { scopeName: summary.scopeName }),
			state: "idle",
			...(runtime.session.sessionFile === undefined ? {} : { sessionFile: runtime.session.sessionFile }),
			thinkingLevel: runtime.session.thinkingLevel,
			pid: process.pid,
			activeSummary: "worker runtime ready",
		});
		return runtime;
	}

	private async createRuntimeForSubagent(summary: {
		id: string;
		kind: ClankySubagentKind;
		scopeId: string;
		scopeName?: string;
	}): Promise<AgentSessionRuntime> {
		const sessionManager = await this.createWorkerSessionManager(summary.id);
		const runtime = await createAgentSessionRuntime(this.createRuntime, {
			cwd: this.cwd,
			agentDir: this.agentDir,
			sessionManager,
		});
		this.runtimes.set(summary.id, { runtime, workerId: summary.id });
		return runtime;
	}

	private async createWorkerSessionManager(workerId: string): Promise<SessionManager> {
		const existing = await this.store.getSubagent(workerId);
		const sessionFile = existing?.sessionFile;
		if (sessionFile !== undefined && (await isReadableFile(sessionFile))) {
			try {
				return SessionManager.open(sessionFile, this.sessionDir, this.cwd);
			} catch (error) {
				this.log(`subagent-session-resume-failed worker=${workerId} file=${sessionFile} error=${errorMessage(error)}`);
			}
		}
		return SessionManager.create(this.cwd, this.sessionDir);
	}

	private mainStatusText(): string {
		const session = this.mainRuntime.session;
		const leaf = session.sessionManager.getLeafEntry();
		const leafText = leafMessageText(leaf);
		return [
			"Main Clanky status:",
			`- busy: ${session.isStreaming ? "yes" : "no"}`,
			`- cwd: ${this.mainRuntime.cwd}`,
			`- sessionId: ${session.sessionId}`,
			...(session.sessionFile === undefined ? [] : [`- sessionFile: ${session.sessionFile}`]),
			...(leafText === undefined ? [] : [`- latest visible session text: ${leafText.slice(0, 500)}`]),
		].join("\n");
	}

	private log(line: string): void {
		if (this.bridgeLogPath === undefined) return;
		appendFile(this.bridgeLogPath, `${new Date().toISOString()} ${line}\n`).catch((error: unknown) => {
			console.error(`discord-subagent log failed: ${errorMessage(error)}`);
		});
	}
}

async function runSubagentTurn(runtime: AgentSessionRuntime, prompt: string): Promise<string | undefined> {
	let finalText: string | undefined;
	const unsubscribe = runtime.session.subscribe((event: AgentSessionEvent) => {
		const text = extractAssistantText(event);
		if (text !== undefined) finalText = text;
	});
	try {
		await runtime.session.prompt(activateDiscordOperatorSkill(prompt), { source: "extension" });
		return finalText;
	} finally {
		unsubscribe();
	}
}

function activateDiscordOperatorSkill(prompt: string): string {
	return `/skill:${DISCORD_OPERATOR_SKILL_NAME} \n\n${prompt}`;
}

function resolveDiscordWorkerTarget(message: DiscordInboundMessage): DiscordWorkerTarget {
	const serverId = message.conversation.serverId?.trim();
	if (serverId !== undefined && serverId.length > 0) {
		return {
			workerId: `discord-guild:${serverId}`,
			kind: "discord-guild",
			scopeId: serverId,
			scopeName: serverId,
		};
	}
	return {
		workerId: `discord-dm:${message.conversation.id}`,
		kind: "discord-dm",
		scopeId: message.conversation.id,
		scopeName: message.conversation.displayName ?? "Discord DM",
	};
}

function priorityForAcceptanceReason(reason: DiscordAcceptanceReason): number {
	if (reason === "dm" || reason === "platform_mention" || reason === "bound_conversation") return 10;
	if (reason === "reply_to_self" || reason === "name_address") return 5;
	return 0;
}

function buildDiscordSubagentPrompt(message: ChatInboxMessage, mainStatus: string): string {
	const sender = message.senderName ?? message.senderId;
	const channel = message.conversationName ?? message.conversationId;
	const attachments = renderAttachments(message.attachments);
	return [
		"You are Clanky's dedicated Discord-facing subagent for this server/DM.",
		"You are not the main Clanky foreground agent, and you are not the live Discord voice agent.",
		"The main Clanky agent remains the user's primary window, AgentRoom/tmux authority, and final coordinator for foreground work.",
		"Keep continuity in your own Pi session instead of requiring main Clanky to carry Discord history.",
		"Use Discord tools to read recent channel activity when the user references context you do not have.",
		"Handle this Discord message as one real person in the conversation.",
		"Answer directly and briefly unless the user asks for detail.",
		"Keep Discord turns short. If work is likely to take more than 1-2 minutes, call delegate_to_main_worker and then give a brief handoff reply.",
		"You cannot spawn child subagents. Use main_agent_activity for live main-agent state, subagent_status to inspect workers, subagent_message for short coordination, main_session_context for deeper foreground context, and delegate_to_main_worker for foreground handoff.",
		"Do not act as the live Discord voice agent. If the user asks Clanky to join, leave, or manage voice chat, use the Discord voice tools and then give a brief handoff; the separate discord-voice subagent owns live voice conversation after join.",
		"Do not claim the main Clanky stopped or changed work unless the status below says so.",
		"Use main_agent_cancel only when the user explicitly asks to stop, cancel, or redirect main foreground work.",
		"Use main_session_context only when you need deeper main-session history than main_agent_activity returns.",
		"If the message does not actually need a reply, output exactly [SKIP].",
		"If you use a Discord send/upload tool for this conversation and that action already satisfies the user, output exactly [SKIP] as your final response instead of posting a duplicate confirmation.",
		"",
		mainStatus,
		"",
		`Discord scope: ${message.kind} ${message.scopeName ?? message.scopeId}`,
		`Discord channel/conversation: ${channel} (${message.conversationKind})`,
		`Acceptance reason: ${message.acceptanceReason}`,
		`Message from ${sender}:`,
		"",
		message.text,
		attachments,
	]
		.filter((part) => part.length > 0)
		.join("\n");
}

function inboxConversation(message: ChatInboxMessage): DiscordInboundConversation {
	const conversation: DiscordInboundConversation = {
		id: message.conversationId,
		kind: readConversationKind(message.conversationKind),
	};
	if (message.serverId !== undefined) conversation.serverId = message.serverId;
	if (message.conversationName !== undefined) conversation.displayName = message.conversationName;
	if (message.conversationThreadId !== undefined) conversation.threadId = message.conversationThreadId;
	if (message.conversationParentId !== undefined) conversation.parentId = message.conversationParentId;
	return conversation;
}

function readConversationKind(value: string): DiscordInboundConversation["kind"] {
	if (value === "dm" || value === "channel" || value === "group" || value === "thread" || value === "custom")
		return value;
	return "custom";
}

function renderAttachments(attachments: readonly ChatInboxAttachment[]): string {
	if (attachments.length === 0) return "";
	return [
		"Attachments:",
		...attachments.map((attachment) => `- ${attachment.url ?? attachment.filename ?? "(unnamed attachment)"}`),
	].join("\n");
}

function leafMessageText(entry: unknown): string | undefined {
	if (typeof entry !== "object" || entry === null || !("type" in entry)) return undefined;
	const record = entry as Record<string, unknown>;
	if (record.type !== "message") return undefined;
	const message = record.message;
	if (typeof message !== "object" || message === null) return undefined;
	const content = (message as Record<string, unknown>).content;
	return contentText(content).trim() || undefined;
}

function contentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.flatMap((part) => {
			if (typeof part !== "object" || part === null) return [];
			const record = part as Record<string, unknown>;
			return record.type === "text" && typeof record.text === "string" ? [record.text] : [];
		})
		.join("\n");
}

function extractAssistantText(event: AgentSessionEvent): string | undefined {
	if (event.type !== "message_end" || event.message.role !== "assistant") return undefined;
	if (event.message.stopReason === "toolUse") return undefined;
	const text = event.message.content
		.filter((part) => part.type === "text")
		.map((part) => part.text)
		.join("\n")
		.trim();
	if (text.length > 0) return text;
	if (event.message.stopReason === "error" && event.message.errorMessage !== undefined) {
		return `I hit an error: ${event.message.errorMessage}`;
	}
	return undefined;
}

function isDiscordSkipReplyText(text: string): boolean {
	return /^\[SKIP\]$/i.test(text.trim());
}

function sessionFileDetails(runtime: AgentSessionRuntime | undefined): { sessionFile?: string } {
	const sessionFile = runtime?.session.sessionFile;
	return sessionFile === undefined ? {} : { sessionFile };
}

function truncateOneLine(text: string, maxLength: number): string {
	const normalized = text.replace(/\s+/g, " ").trim();
	if (normalized.length <= maxLength) return normalized;
	if (maxLength <= 3) return normalized.slice(0, maxLength);
	return `${normalized.slice(0, maxLength - 3)}...`;
}

async function isReadableFile(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? (error.stack ?? error.message) : String(error);
}
