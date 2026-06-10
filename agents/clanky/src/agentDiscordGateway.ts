import { appendFile } from "node:fs/promises";
import { DiscordChatGatewayProvider, type DiscordGatewayClient } from "@clanky/chat-discord";
import {
	type ChatInboxMessage,
	type ClankyDiscordCredentialKind,
	type ClankySubagentStore,
	DEFAULT_CLANKY_DISCORD_PROVIDER_ID,
	type DiscordMessageSummary,
	errorMessage,
	loadStoredDiscordCredential,
	readDiscordMessages,
	type SendSubagentMessageInput,
	type SendSubagentMessageResult,
	shouldStartAgentChatGateway,
} from "@clanky/core";
import type {
	AgentSessionEvent,
	AgentSessionRuntime,
	AuthStorage,
	CreateAgentSessionRuntimeFactory,
	PromptOptions,
} from "@earendil-works/pi-coding-agent";
import type {
	AgentChatAttachment,
	AgentChatConversation,
	AgentChatGatewayHandle,
	AgentChatGatewayProvider,
	AgentChatInboundMessage,
	AgentChatSender,
} from "./agentChatGateway.ts";
import { createAgentDiscordClient } from "./agentDiscordClient.ts";
import { startChatTypingIndicator, withChatTypingIndicator } from "./chatTyping.ts";
import type { ClankyThinkingLevel } from "./clankyDefaults.ts";
import { DiscordSubagentCoordinator } from "./discordSubagentCoordinator.ts";
import { DEFAULT_DISCORD_WAKE_NAMES, dedupeWakeNames, parseDiscordWakeNamesFromEnv } from "./discordWakeNames.ts";
import { type RuntimeTurnQueue, SerialRuntimeTurnQueue } from "./runtimeTurnQueue.ts";

type DiscordCredentialKind = ClankyDiscordCredentialKind;

export type DiscordInboundConversation = AgentChatConversation;
export type DiscordInboundSender = AgentChatSender;
export type DiscordInboundAttachment = AgentChatAttachment;
export type DiscordInboundMessage = AgentChatInboundMessage;

export type ClankyAgentDiscordGatewayConfigSource = "env" | "stored";

export interface ClankyAgentDiscordCredentialConfig {
	providerId: string;
	token: string;
	credentialKind: DiscordCredentialKind;
	source: ClankyAgentDiscordGatewayConfigSource;
}

export interface ClankyAgentDiscordGatewayConfig extends ClankyAgentDiscordCredentialConfig {
	conversationId?: string;
}

interface PendingDiscordReply {
	conversation: DiscordInboundMessage["conversation"];
	replyToExternalMessageId: string;
	senderId: string;
	channelId: string;
	acceptanceReason: DiscordAcceptanceReason;
}

export interface DiscordConversationHistoryEntry {
	author: string;
	text: string;
	attachmentLabels: string[];
	attachments?: DiscordConversationAttachmentEntry[];
	messageId?: string;
}

export interface DiscordConversationAttachmentEntry {
	url?: string;
	filename?: string;
	mime?: string;
	contentType?: string;
}

export interface DiscordConversationPromptMetadata {
	conversationId: string;
	conversationKind: DiscordInboundConversation["kind"];
	messageId: string;
	serverId?: string;
	threadId?: string;
	parentId?: string;
	displayName?: string;
}

export type DiscordPromptImageContent = NonNullable<PromptOptions["images"]>[number];

export interface DiscordPromptImageCandidate {
	label: string;
	url: string;
	mimeType?: string;
}

export interface DiscordPromptImageReference {
	index: number;
	label: string;
	sourceUrl: string;
	mimeType: string;
}

export interface DiscordPromptImages {
	images: DiscordPromptImageContent[];
	references: DiscordPromptImageReference[];
	failures: string[];
}

export interface ResolveDiscordPromptImagesOptions {
	maxImages?: number;
	maxBytes?: number;
	fetchImage?: (candidate: DiscordPromptImageCandidate, maxBytes: number) => Promise<DiscordPromptImageContent>;
}

export interface DiscordSubagentRoutingState {
	subagentsAvailable: boolean;
	mainSessionStreaming: boolean;
	mainQueueBusy: boolean;
}

export type DiscordBridgeCommand =
	| {
			type: "direct";
			prompt: string;
	  }
	| {
			type: "new";
	  }
	| {
			type: "compact";
			customInstructions?: string;
	  }
	| {
			type: "help";
	  };

const DEFAULT_ENGAGEMENT_WINDOW_MS = 5 * 60 * 1000;
const DISCORD_BRIDGE_COMMAND_PREFIXES = ["/clanky", "/clank", "!clanky", "!clank"];
const MAX_TRACKED_SELF_MESSAGES = 200;
const MAX_CONVERSATION_HISTORY_MESSAGES = 20;
const MAX_DISCORD_PROMPT_IMAGES = 4;
const MAX_DISCORD_PROMPT_IMAGE_BYTES = 8 * 1024 * 1024;
const DISCORD_IMAGE_FETCH_TIMEOUT_MS = 10_000;
const PRIMARY_WAKE_TOKEN_MIN_LEN = 4;
const EN_WAKE_PRIMARY_GENERIC_TOKENS = new Set(["bot", "ai", "assistant"]);
const LEADING_WAKE_PREFIX_TOKENS = new Set([
	"yo",
	"hey",
	"hi",
	"hello",
	"sup",
	"ay",
	"ayy",
	"oi",
	"ok",
	"okay",
	"alright",
	"please",
]);

function resolveEngagementWindowMs(env: NodeJS.ProcessEnv): number {
	const raw = env.CLANKY_DISCORD_ENGAGEMENT_WINDOW_MINUTES?.trim();
	if (raw === undefined || raw.length === 0) return DEFAULT_ENGAGEMENT_WINDOW_MS;
	const minutes = Number.parseFloat(raw);
	if (!Number.isFinite(minutes) || minutes < 0) return DEFAULT_ENGAGEMENT_WINDOW_MS;
	return Math.floor(minutes * 60 * 1000);
}

function resolveDiscordWakeNames(env: NodeJS.ProcessEnv): string[] {
	return parseDiscordWakeNamesFromEnv(env);
}

export interface ClankyAgentDiscordGatewayHandle extends AgentChatGatewayHandle {
	readonly client: DiscordGatewayClient;
}

/**
 * Resolve the Discord gateway config.
 *
 * Precedence:
 *  1. Owner gate. If `CLANKY_CHAT_GATEWAY_OWNER` resolves to `room` or
 *     `off` the agent-owned gateway is suppressed entirely.
 *  2. `CLANKY_DISCORD_TOKEN` env always wins over stored credentials. Companion env vars
 *     `CLANKY_DISCORD_CREDENTIAL_KIND`, `CLANKY_DISCORD_PROVIDER_ID`,
 *     and `CLANKY_DISCORD_CONVERSATION_ID` take effect when env is the source.
 *  3. Stored credential in profile `AuthStorage` under the configured
 *     provider id (default `clanky-discord`), saved via `/discord-login`.
 *     Env vars for credential kind / conversation id still override
 *     the stored values when present.
 *  4. None of the above -> undefined; gateway does not start.
 *
 * The function is sync — `AuthStorage` is loaded at construction time.
 */
export function resolveAgentDiscordGatewayConfig(
	env: NodeJS.ProcessEnv = process.env,
	authStorage?: AuthStorage,
): ClankyAgentDiscordGatewayConfig | undefined {
	if (!shouldStartAgentChatGateway(env)) return undefined;
	const credential = resolveAgentDiscordCredentialConfig(env, authStorage);
	if (credential === undefined) return undefined;
	const conversationId = resolveAgentDiscordConversationId(env, authStorage, credential);
	return {
		...credential,
		...(conversationId === undefined ? {} : { conversationId }),
	};
}

/**
 * Resolve Discord credentials without applying the chat owner gate.
 *
 * Voice uses the same Discord credential but owns a media connection, not a
 * text chat gateway. Keeping this resolver separate lets
 * CLANKY_CHAT_GATEWAY_OWNER=room/off suppress text handling without making
 * Discord voice impossible.
 */
export function resolveAgentDiscordCredentialConfig(
	env: NodeJS.ProcessEnv = process.env,
	authStorage?: AuthStorage,
): ClankyAgentDiscordCredentialConfig | undefined {
	const providerId = env.CLANKY_DISCORD_PROVIDER_ID?.trim() || DEFAULT_CLANKY_DISCORD_PROVIDER_ID;
	const envCredentialKindRaw = env.CLANKY_DISCORD_CREDENTIAL_KIND?.trim();

	const envToken = env.CLANKY_DISCORD_TOKEN?.trim();
	if (envToken !== undefined && envToken.length > 0) {
		const credentialKind = parseDiscordCredentialKind(envCredentialKindRaw);
		return {
			providerId,
			token: envToken,
			credentialKind,
			source: "env",
		};
	}

	if (authStorage === undefined) return undefined;
	const stored = loadStoredDiscordCredential(authStorage, providerId);
	if (stored === undefined) return undefined;

	const credentialKind =
		envCredentialKindRaw !== undefined && envCredentialKindRaw.length > 0
			? parseDiscordCredentialKind(envCredentialKindRaw)
			: stored.payload.credentialKind;
	return {
		providerId: stored.providerId,
		token: stored.payload.token,
		credentialKind,
		source: "stored",
	};
}

function resolveAgentDiscordConversationId(
	env: NodeJS.ProcessEnv,
	authStorage: AuthStorage | undefined,
	credential: ClankyAgentDiscordCredentialConfig,
): string | undefined {
	const envConversationId = env.CLANKY_DISCORD_CONVERSATION_ID?.trim() || undefined;
	if (envConversationId !== undefined) return envConversationId;
	if (credential.source !== "stored" || authStorage === undefined) return undefined;
	return loadStoredDiscordCredential(authStorage, credential.providerId)?.payload.conversationId;
}

export interface StartAgentDiscordGatewayInput {
	runtime: AgentSessionRuntime;
	authStorage?: AuthStorage;
	config?: ClankyAgentDiscordGatewayConfig;
	client?: DiscordGatewayClient;
	runtimeTurnQueue?: RuntimeTurnQueue;
	createSubagentRuntime?: CreateAgentSessionRuntimeFactory;
	/** Append-only log of inbound/outbound timing — pass `<profileDir>/discord-bridge.log` from runClanky. */
	bridgeLogPath?: string;
	subagentStore?: ClankySubagentStore;
	subagentSessionDir?: string;
	subagentCwd?: string;
	/** Override default 5-minute engagement window. 0 disables. */
	engagementWindowMs?: number;
	/** Natural-language names that count as mentioning Clanky in unbound Discord channels. */
	wakeNames?: string[];
}

export async function startAgentDiscordGateway(
	input: StartAgentDiscordGatewayInput,
): Promise<ClankyAgentDiscordGatewayHandle | undefined> {
	const config = input.config ?? resolveAgentDiscordGatewayConfig(process.env, input.authStorage);
	if (config === undefined) return undefined;
	const client = input.client ?? createAgentDiscordClient();

	const provider = new DiscordChatGatewayProvider({
		id: config.providerId,
		token: config.token,
		credentialKind: config.credentialKind,
		ignoreBotMessages: false,
		client,
	});
	const subagents =
		input.createSubagentRuntime !== undefined &&
		input.subagentStore !== undefined &&
		input.subagentSessionDir !== undefined
			? new DiscordSubagentCoordinator({
					provider,
					store: input.subagentStore,
					mainRuntime: input.runtime,
					createRuntime: input.createSubagentRuntime,
					agentDir: input.runtime.services.agentDir,
					cwd: input.subagentCwd ?? input.runtime.cwd,
					sessionDir: input.subagentSessionDir,
					...(input.bridgeLogPath === undefined ? {} : { bridgeLogPath: input.bridgeLogPath }),
				})
			: undefined;
	const engagementWindowMs = input.engagementWindowMs ?? resolveEngagementWindowMs(process.env);
	const bridge = new AgentDiscordBridge(input.runtime, provider, config, client, {
		engagementWindowMs,
		wakeNames: input.wakeNames ?? resolveDiscordWakeNames(process.env),
		runtimeTurnQueue: input.runtimeTurnQueue ?? new SerialRuntimeTurnQueue(),
		...(input.authStorage === undefined ? {} : { authStorage: input.authStorage }),
		...(subagents === undefined ? {} : { subagents }),
		...(input.bridgeLogPath !== undefined ? { bridgeLogPath: input.bridgeLogPath } : {}),
	});
	await bridge.start();
	return bridge;
}

interface AgentDiscordBridgeOptions {
	engagementWindowMs: number;
	wakeNames: string[];
	runtimeTurnQueue: RuntimeTurnQueue;
	authStorage?: AuthStorage;
	subagents?: DiscordSubagentCoordinator;
	bridgeLogPath?: string;
}

export type DiscordAcceptanceReason =
	| "bound_conversation"
	| "dm"
	| "discord_command"
	| "platform_mention"
	| "reply_to_self"
	| "name_address"
	| "name_mention"
	| "recent_engagement";

export type DiscordIgnoreReason = "not_engaged_no_mention";

export type DiscordAcceptanceDecision =
	| {
			accepted: true;
			reason: DiscordAcceptanceReason;
			recordInboundEngagement: boolean;
	  }
	| {
			accepted: false;
			reason: DiscordIgnoreReason;
	  };

class AgentDiscordBridge implements ClankyAgentDiscordGatewayHandle {
	readonly client: DiscordGatewayClient;
	private readonly runtime: AgentSessionRuntime;
	private readonly provider: AgentChatGatewayProvider;
	private readonly config: ClankyAgentDiscordGatewayConfig;
	private readonly options: AgentDiscordBridgeOptions;
	private readonly runtimeTurnQueue: RuntimeTurnQueue;
	private readonly subagents: DiscordSubagentCoordinator | undefined;
	private unsubscribe: (() => void) | undefined;
	private subscribedSession: AgentSessionRuntime["session"];
	private readonly pendingReplies: PendingDiscordReply[] = [];
	/** Per channel and per (channelId, userId) most-recent engagement timestamp (ms). */
	private readonly conversationEngagements = new Map<string, number>();
	private readonly engagements = new Map<string, number>();
	private readonly inboundReceivedAt = new Map<string, number>();
	private readonly recentConversationMessages = new Map<string, DiscordConversationHistoryEntry[]>();
	private readonly selfMessageIds = new Set<string>();
	private readonly selfMessageIdOrder: string[] = [];

	constructor(
		runtime: AgentSessionRuntime,
		provider: AgentChatGatewayProvider,
		config: ClankyAgentDiscordGatewayConfig,
		client: DiscordGatewayClient,
		options: AgentDiscordBridgeOptions,
	) {
		this.runtime = runtime;
		this.provider = provider;
		this.config = config;
		this.client = client;
		this.options = options;
		this.runtimeTurnQueue = options.runtimeTurnQueue;
		this.subagents = options.subagents;
		this.subagents?.setResponseObserver((event) => this.handleSubagentResponseSent(event));
		this.subscribedSession = runtime.session;
	}

	async start(): Promise<void> {
		this.subscribeToCurrentSession();
		await this.provider.start(async (rawMessage: unknown) => {
			const message = normalizeDiscordInboundMessage(rawMessage);
			const t1 = Date.now();
			const channelId = message.conversation.id;
			const senderId = message.sender.id;
			const command = parseDiscordBridgeCommand(message.text);
			if (command !== undefined) {
				this.inboundReceivedAt.set(message.externalMessageId, t1);
				this.recordEngagement(channelId, senderId);
				this.logBridge(
					`command accepted ext=${message.externalMessageId} channel=${channelId} from=${senderId} type=${command.type}`,
				);
				await this.handleBridgeCommand(message, command, t1);
				return;
			}
			const decision = evaluateDiscordMessageAcceptance(message, this.config, {
				isEngaged: (c, u) => this.isEngaged(c, u),
				isKnownSelfMessage: (id) => this.selfMessageIds.has(id),
				wakeNames: this.resolveWakeNames(),
			});
			if (!decision.accepted) {
				this.logBridge(
					`inbound ignored ext=${message.externalMessageId} channel=${channelId} from=${senderId} reason=${decision.reason}`,
				);
				return;
			}
			if (decision.recordInboundEngagement) this.recordEngagement(channelId, senderId);
			this.inboundReceivedAt.set(message.externalMessageId, t1);
			this.logBridge(
				`inbound accepted ext=${message.externalMessageId} channel=${channelId} from=${senderId} reason=${decision.reason}`,
			);
			const subagents = this.subagents;
			if (subagents !== undefined && this.shouldRouteToSubagent()) {
				this.recordInboundMessage(message);
				await subagents.enqueue(message, decision.reason);
				this.logBridge(
					`queued-for-subagent ext=${message.externalMessageId} channel=${channelId} mainStreaming=${
						this.runtime.session.isStreaming
					} mainQueueBusy=${this.runtimeTurnQueue.isBusy()}`,
				);
				return;
			}
			await this.forwardToMainRuntime(message, decision.reason, t1);
		});
		await this.subagents?.start();
	}

	private async forwardToMainRuntime(
		message: DiscordInboundMessage,
		acceptanceReason: DiscordAcceptanceReason,
		receivedAt: number,
	): Promise<void> {
		const stopTyping = startChatTypingIndicator(this.provider, message.conversation, {
			onError: (error) => this.logBridge(`typing-failed ext=${message.externalMessageId} error=${errorMessage(error)}`),
		});
		try {
			const channelId = message.conversation.id;
			const senderId = message.sender.id;
			await this.refreshConversationHistoryFromDiscord(message);
			const history = this.recentConversationMessages.get(conversationHistoryKey(message.conversation)) ?? [];
			const promptImages = await resolveDiscordPromptImages(message, history);
			for (const failure of promptImages.failures) {
				this.logBridge(`image-fetch-failed ext=${message.externalMessageId} ${failure}`);
			}
			const userPrompt = this.formatDiscordUserMessage(message, acceptanceReason, history, promptImages.references);
			const pending: PendingDiscordReply = {
				conversation: message.conversation,
				replyToExternalMessageId: message.externalMessageId,
				senderId,
				channelId,
				acceptanceReason,
			};
			this.recordInboundMessage(message);
			this.pendingReplies.push(pending);
			try {
				await this.runtimeTurnQueue.enqueuePrompt(this.runtime, userPrompt, {
					beforePrompt: () => this.subscribeToCurrentSession(),
					...(promptImages.images.length === 0 ? {} : { images: promptImages.images }),
				});
			} catch (error) {
				this.removePendingReply(pending);
				this.inboundReceivedAt.delete(message.externalMessageId);
				throw error;
			}
			this.logBridge(`forwarded-to-pi ext=${message.externalMessageId} dt=${Date.now() - receivedAt}ms`);
		} finally {
			stopTyping();
		}
	}

	async stop(): Promise<void> {
		this.unsubscribe?.();
		this.unsubscribe = undefined;
		await this.subagents?.stop();
		await this.provider.stop();
	}

	setSubagentThinkingLevel(level: ClankyThinkingLevel): number {
		return this.subagents?.setThinkingLevel(level) ?? 0;
	}

	async sendSubagentMessage(input: SendSubagentMessageInput): Promise<SendSubagentMessageResult | undefined> {
		return await this.subagents?.sendInteractiveMessage(input);
	}

	private shouldRouteToSubagent(): boolean {
		return shouldRouteDiscordMessageToSubagent({
			subagentsAvailable: this.subagents !== undefined,
			mainSessionStreaming: this.runtime.session.isStreaming,
			mainQueueBusy: this.runtimeTurnQueue.isBusy(),
		});
	}

	private subscribeToCurrentSession(): void {
		if (this.unsubscribe !== undefined && this.subscribedSession === this.runtime.session) return;
		this.unsubscribe?.();
		this.subscribedSession = this.runtime.session;
		this.unsubscribe = this.runtime.session.subscribe((event) => {
			void this.handleSessionEvent(event).catch((error: unknown) => {
				console.error(error instanceof Error ? error.message : String(error));
			});
		});
	}

	private async handleSessionEvent(event: AgentSessionEvent): Promise<void> {
		const text = extractAssistantText(event);
		if (text === undefined) return;

		const pending = this.pendingReplies.shift();
		if (pending === undefined) return;

		const t3 = Date.now();
		const t1 = this.inboundReceivedAt.get(pending.replyToExternalMessageId);
		this.inboundReceivedAt.delete(pending.replyToExternalMessageId);
		this.logBridge(
			`pi-reply-ready ext=${pending.replyToExternalMessageId} chars=${text.length}${
				t1 !== undefined ? ` since-inbound=${t3 - t1}ms` : ""
			}`,
		);
		if (isDiscordSkipReplyText(text)) {
			this.logBridge(
				`discord-skipped ext=${pending.replyToExternalMessageId} reason=model_skip${
					t1 !== undefined ? ` total=${Date.now() - t1}ms` : ""
				}`,
			);
			return;
		}

		const sent = await this.provider.sendMessage({
			conversation: pending.conversation,
			replyToExternalMessageId: pending.replyToExternalMessageId,
			text,
		});
		this.rememberSelfMessageId(sent.externalMessageId);
		this.recordAssistantMessage(conversationHistoryKey(pending.conversation), sent.externalMessageId, text);
		this.recordEngagement(pending.channelId, pending.senderId);
		this.logBridge(
			`discord-sent ext=${pending.replyToExternalMessageId} reply-id=${sent.externalMessageId} send-dt=${
				Date.now() - t3
			}ms${t1 !== undefined ? ` total=${Date.now() - t1}ms` : ""} reason=${pending.acceptanceReason}`,
		);
	}

	private isEngaged(channelId: string, userId: string): boolean {
		if (this.options.engagementWindowMs <= 0) return false;
		if (this.isRecentEngagement(this.conversationEngagements.get(channelId))) return true;
		const last = this.engagements.get(engagementKey(channelId, userId));
		return this.isRecentEngagement(last);
	}

	private isRecentEngagement(last: number | undefined): boolean {
		if (last === undefined) return false;
		return Date.now() - last < this.options.engagementWindowMs;
	}

	private recordEngagement(channelId: string, userId: string): void {
		if (this.options.engagementWindowMs <= 0) return;
		this.conversationEngagements.set(channelId, Date.now());
		this.engagements.set(engagementKey(channelId, userId), Date.now());
	}

	private rememberSelfMessageId(messageId: string): void {
		const normalized = messageId.trim();
		if (normalized.length === 0 || this.selfMessageIds.has(normalized)) return;
		this.selfMessageIds.add(normalized);
		this.selfMessageIdOrder.push(normalized);
		while (this.selfMessageIdOrder.length > MAX_TRACKED_SELF_MESSAGES) {
			const expired = this.selfMessageIdOrder.shift();
			if (expired !== undefined) this.selfMessageIds.delete(expired);
		}
	}

	private removePendingReply(pending: PendingDiscordReply): void {
		const index = this.pendingReplies.indexOf(pending);
		if (index >= 0) this.pendingReplies.splice(index, 1);
	}

	private resolveWakeNames(): string[] {
		const user = this.client.user;
		const clientNames = [user?.username, user?.tag?.split("#")[0]].filter(
			(value): value is string => value !== undefined && value.trim().length > 0,
		);
		return dedupeWakeNames([...DEFAULT_DISCORD_WAKE_NAMES, ...clientNames, ...this.options.wakeNames]);
	}

	private formatDiscordUserMessage(
		message: DiscordInboundMessage,
		reason: DiscordAcceptanceReason,
		history: DiscordConversationHistoryEntry[],
		imageReferences: DiscordPromptImageReference[],
	): string {
		return formatDiscordUserMessage(message, reason, history, conversationPromptMetadata(message), imageReferences);
	}

	private async handleBridgeCommand(
		message: DiscordInboundMessage,
		command: DiscordBridgeCommand,
		receivedAt: number,
	): Promise<void> {
		if (command.type === "direct") {
			const prompt = command.prompt.trim();
			if (prompt.length === 0) {
				await this.sendBridgeCommandReply(message, discordBridgeCommandHelpText());
				return;
			}
			await this.forwardToMainRuntime({ ...message, text: prompt }, "discord_command", receivedAt);
			return;
		}
		if (command.type === "new") {
			this.recordInboundMessage(message);
			await this.runBridgeControlCommand(message, "new-session", async () => {
				const result = await this.runtimeTurnQueue.enqueue(async () => {
					this.clearPendingMainReplies();
					const newSessionResult = await this.runtime.newSession();
					this.subscribeToCurrentSession();
					return newSessionResult;
				});
				if (result.cancelled) throw new Error("new session was cancelled");
				return "Started a new main Clanky session.";
			});
			return;
		}
		if (command.type === "compact") {
			this.recordInboundMessage(message);
			await this.runBridgeControlCommand(message, "compact", async () => {
				const result = await this.runtimeTurnQueue.enqueue(async () => {
					this.clearPendingMainReplies();
					return await this.runtime.session.compact(command.customInstructions);
				});
				return `Compacted main Clanky context. Tokens before: ${result.tokensBefore}.`;
			});
			return;
		}
		await this.sendBridgeCommandReply(message, discordBridgeCommandHelpText());
	}

	private async runBridgeControlCommand(
		message: DiscordInboundMessage,
		label: string,
		task: () => Promise<string>,
	): Promise<void> {
		try {
			const reply = await withChatTypingIndicator(this.provider, message.conversation, task, {
				onError: (error) =>
					this.logBridge(`typing-failed ext=${message.externalMessageId} type=${label} error=${errorMessage(error)}`),
			});
			await this.sendBridgeCommandReply(message, reply);
			this.logBridge(`command-complete ext=${message.externalMessageId} type=${label}`);
		} catch (error) {
			const text = error instanceof Error ? error.message : String(error);
			this.logBridge(`command-failed ext=${message.externalMessageId} type=${label} error=${text}`);
			await this.sendBridgeCommandReply(message, `Command failed: ${text}`);
		}
	}

	private async sendBridgeCommandReply(message: DiscordInboundMessage, text: string): Promise<void> {
		const sent = await this.provider.sendMessage({
			conversation: message.conversation,
			replyToExternalMessageId: message.externalMessageId,
			text,
		});
		this.rememberSelfMessageId(sent.externalMessageId);
		this.recordAssistantMessage(conversationHistoryKey(message.conversation), sent.externalMessageId, text);
		this.recordEngagement(message.conversation.id, message.sender.id);
		this.inboundReceivedAt.delete(message.externalMessageId);
	}

	private handleSubagentResponseSent(event: {
		message: ChatInboxMessage;
		sentExternalMessageId: string;
		text: string;
	}): void {
		this.rememberSelfMessageId(event.sentExternalMessageId);
		this.recordAssistantMessage(
			event.message.conversationThreadId ?? event.message.conversationId,
			event.sentExternalMessageId,
			event.text,
		);
		this.recordEngagement(event.message.conversationId, event.message.senderId);
	}

	private clearPendingMainReplies(): void {
		for (const pending of this.pendingReplies) this.inboundReceivedAt.delete(pending.replyToExternalMessageId);
		this.pendingReplies.length = 0;
	}

	private recordInboundMessage(message: DiscordInboundMessage): void {
		const author = message.sender.displayName ?? message.sender.username ?? message.sender.id;
		this.recordConversationMessage(conversationHistoryKey(message.conversation), {
			author,
			text: message.text.trim() || "(no text)",
			attachmentLabels: message.attachments
				.map((attachment) => attachment.filename ?? attachment.url)
				.filter((value): value is string => value !== undefined && value.trim().length > 0),
			attachments: message.attachments.map(discordInboundAttachmentToHistoryAttachment),
			messageId: message.externalMessageId,
		});
	}

	private async refreshConversationHistoryFromDiscord(message: DiscordInboundMessage): Promise<void> {
		const channelId = conversationHistoryKey(message.conversation);
		try {
			const messages = await readDiscordMessages(
				{
					channel_id: channelId,
					limit: MAX_CONVERSATION_HISTORY_MESSAGES,
					before: message.externalMessageId,
				},
				{
					...(this.options.authStorage === undefined ? {} : { authStorage: this.options.authStorage }),
				},
			);
			this.mergeConversationHistory(channelId, messages.slice().reverse().map(discordMessageToHistoryEntry));
		} catch (error) {
			this.logBridge(
				`history-fetch-failed ext=${message.externalMessageId} channel=${channelId} error=${
					error instanceof Error ? error.message : String(error)
				}`,
			);
		}
	}

	private recordAssistantMessage(channelId: string, messageId: string, text: string): void {
		this.recordConversationMessage(channelId, {
			author: "Clanky",
			text,
			attachmentLabels: [],
			messageId,
		});
	}

	private recordConversationMessage(channelId: string, entry: DiscordConversationHistoryEntry): void {
		const entries = this.recentConversationMessages.get(channelId) ?? [];
		entries.push(entry);
		while (entries.length > MAX_CONVERSATION_HISTORY_MESSAGES) entries.shift();
		this.recentConversationMessages.set(channelId, entries);
	}

	private mergeConversationHistory(channelId: string, entries: DiscordConversationHistoryEntry[]): void {
		if (entries.length === 0) return;
		const existing = this.recentConversationMessages.get(channelId) ?? [];
		const incomingIds = new Set(entries.flatMap((entry) => (entry.messageId === undefined ? [] : [entry.messageId])));
		const merged = [
			...existing.filter((entry) => entry.messageId === undefined || !incomingIds.has(entry.messageId)),
			...entries,
		];
		while (merged.length > MAX_CONVERSATION_HISTORY_MESSAGES) merged.shift();
		this.recentConversationMessages.set(channelId, merged);
	}

	private logBridge(line: string): void {
		const path = this.options.bridgeLogPath;
		if (path === undefined) return;
		const entry = `${new Date().toISOString()} ${line}\n`;
		appendFile(path, entry).catch((error: unknown) => {
			console.error(`discord-bridge log failed: ${error instanceof Error ? error.message : String(error)}`);
		});
	}
}

function engagementKey(channelId: string, userId: string): string {
	return `${channelId}:${userId}`;
}

function normalizeDiscordInboundMessage(rawMessage: unknown): DiscordInboundMessage {
	const message = rawMessage as DiscordInboundMessage & {
		conversation: DiscordInboundConversation & { guildId?: string };
	};
	const serverId = message.conversation.serverId ?? message.conversation.guildId;
	return {
		...message,
		conversation: {
			...message.conversation,
			...(serverId === undefined ? {} : { serverId }),
		},
	};
}

export function shouldRouteDiscordMessageToSubagent(state: DiscordSubagentRoutingState): boolean {
	return state.subagentsAvailable;
}

function conversationHistoryKey(conversation: DiscordInboundConversation): string {
	return conversation.threadId ?? conversation.id;
}

function conversationPromptMetadata(message: DiscordInboundMessage): DiscordConversationPromptMetadata {
	return {
		conversationId: message.conversation.id,
		conversationKind: message.conversation.kind,
		messageId: message.externalMessageId,
		...(message.conversation.serverId === undefined ? {} : { serverId: message.conversation.serverId }),
		...(message.conversation.threadId === undefined ? {} : { threadId: message.conversation.threadId }),
		...(message.conversation.parentId === undefined ? {} : { parentId: message.conversation.parentId }),
		...(message.conversation.displayName === undefined ? {} : { displayName: message.conversation.displayName }),
	};
}

function discordMessageToHistoryEntry(message: DiscordMessageSummary): DiscordConversationHistoryEntry {
	return {
		author: message.authorUsername ?? message.authorId ?? "unknown",
		text: message.content.trim() || "(no text)",
		attachmentLabels: message.attachmentUrls,
		attachments: message.attachments.map((attachment) => ({
			...(attachment.url === undefined ? {} : { url: attachment.url }),
			...(attachment.filename === undefined ? {} : { filename: attachment.filename }),
			...(attachment.contentType === undefined ? {} : { contentType: attachment.contentType }),
		})),
		messageId: message.id,
	};
}

function discordInboundAttachmentToHistoryAttachment(
	attachment: DiscordInboundAttachment,
): DiscordConversationAttachmentEntry {
	return {
		...(attachment.url === undefined ? {} : { url: attachment.url }),
		...(attachment.filename === undefined ? {} : { filename: attachment.filename }),
		...(attachment.mime === undefined ? {} : { mime: attachment.mime }),
		...(attachment.contentType === undefined ? {} : { contentType: attachment.contentType }),
	};
}

export async function resolveDiscordPromptImages(
	message: DiscordInboundMessage,
	history: readonly DiscordConversationHistoryEntry[],
	options: ResolveDiscordPromptImagesOptions = {},
): Promise<DiscordPromptImages> {
	const maxImages = clampPositiveInt(options.maxImages, MAX_DISCORD_PROMPT_IMAGES);
	const maxBytes = clampPositiveInt(options.maxBytes, MAX_DISCORD_PROMPT_IMAGE_BYTES);
	const fetchImage = options.fetchImage ?? fetchDiscordPromptImage;
	const candidates = maxImages === 0 ? [] : collectDiscordPromptImageCandidates(message, history).slice(-maxImages);
	const images: DiscordPromptImageContent[] = [];
	const references: DiscordPromptImageReference[] = [];
	const failures: string[] = [];

	for (const candidate of candidates) {
		try {
			const image = await fetchImage(candidate, maxBytes);
			images.push(image);
			references.push({
				index: images.length,
				label: candidate.label,
				sourceUrl: candidate.url,
				mimeType: image.mimeType,
			});
		} catch (error) {
			failures.push(
				`label=${JSON.stringify(candidate.label)} url=${candidate.url} error=${
					error instanceof Error ? error.message : String(error)
				}`,
			);
		}
	}

	return { images, references, failures };
}

function collectDiscordPromptImageCandidates(
	message: DiscordInboundMessage,
	history: readonly DiscordConversationHistoryEntry[],
): DiscordPromptImageCandidate[] {
	const candidates: DiscordPromptImageCandidate[] = [];
	for (const entry of history) {
		const sourceLabel =
			entry.messageId === undefined ? `recent message from ${entry.author}` : `message ${entry.messageId}`;
		const attachments: DiscordConversationAttachmentEntry[] =
			entry.attachments ?? entry.attachmentLabels.map((label) => ({ url: label }));
		for (const attachment of attachments) {
			const attachmentName = "filename" in attachment ? (attachment.filename ?? attachment.url ?? "") : attachment.url;
			const candidate = promptImageCandidateFromAttachment(
				attachment,
				`${sourceLabel} attachment ${attachmentName}`.trim(),
			);
			if (candidate !== undefined) candidates.push(candidate);
		}
	}
	for (const attachment of message.attachments) {
		const candidate = promptImageCandidateFromAttachment(
			attachment,
			`newest message attachment ${attachment.filename ?? attachment.url ?? ""}`.trim(),
		);
		if (candidate !== undefined) candidates.push(candidate);
	}
	return candidates;
}

function promptImageCandidateFromAttachment(
	attachment: DiscordConversationAttachmentEntry,
	label: string,
): DiscordPromptImageCandidate | undefined {
	const url = normalizeHttpUrl(attachment.url);
	if (url === undefined) return undefined;
	const mimeType =
		normalizeImageMimeType(attachment.mime) ??
		normalizeImageMimeType(attachment.contentType) ??
		inferImageMimeType(attachment.filename) ??
		inferImageMimeType(url);
	if (mimeType === undefined) return undefined;
	return { label, url, mimeType };
}

async function fetchDiscordPromptImage(
	candidate: DiscordPromptImageCandidate,
	maxBytes: number,
): Promise<DiscordPromptImageContent> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), DISCORD_IMAGE_FETCH_TIMEOUT_MS);
	timeout.unref?.();
	try {
		const response = await fetch(candidate.url, { signal: controller.signal });
		if (!response.ok) {
			throw new Error(`HTTP ${response.status} ${response.statusText}`);
		}
		const contentLength = response.headers.get("content-length");
		if (contentLength !== null) {
			const bytes = Number.parseInt(contentLength, 10);
			if (Number.isFinite(bytes) && bytes > maxBytes) {
				throw new Error(`image is ${bytes} bytes, limit is ${maxBytes}`);
			}
		}
		const responseMimeType = normalizeImageMimeType(response.headers.get("content-type") ?? undefined);
		const mimeType = responseMimeType ?? candidate.mimeType;
		if (mimeType === undefined) throw new Error("response is not a supported image type");
		const bytes = Buffer.from(await response.arrayBuffer());
		if (bytes.byteLength > maxBytes) {
			throw new Error(`image is ${bytes.byteLength} bytes, limit is ${maxBytes}`);
		}
		return {
			type: "image",
			data: bytes.toString("base64"),
			mimeType,
		};
	} finally {
		clearTimeout(timeout);
	}
}

function normalizeHttpUrl(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	if (trimmed === undefined || trimmed.length === 0) return undefined;
	try {
		const parsed = new URL(trimmed);
		if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return undefined;
		return parsed.toString();
	} catch {
		return undefined;
	}
}

function normalizeImageMimeType(value: string | undefined): string | undefined {
	const type = value?.split(";")[0]?.trim().toLowerCase();
	if (type === "image/png" || type === "image/jpeg" || type === "image/webp" || type === "image/gif") {
		return type;
	}
	return undefined;
}

function inferImageMimeType(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	if (trimmed === undefined || trimmed.length === 0) return undefined;
	let path = trimmed;
	try {
		path = new URL(trimmed).pathname;
	} catch {
		path = trimmed;
	}
	let lower = path.toLowerCase();
	try {
		lower = decodeURIComponent(path).toLowerCase();
	} catch {
		lower = path.toLowerCase();
	}
	if (lower.endsWith(".png")) return "image/png";
	if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
	if (lower.endsWith(".webp")) return "image/webp";
	if (lower.endsWith(".gif")) return "image/gif";
	return undefined;
}

function clampPositiveInt(value: number | undefined, fallback: number): number {
	if (value === undefined || !Number.isFinite(value)) return fallback;
	return Math.max(0, Math.floor(value));
}

function parseDiscordCredentialKind(value: string | undefined): DiscordCredentialKind {
	if (value === undefined || value === "") return "bot-token";
	if (value === "bot-token" || value === "user-token") return value;
	throw new Error("CLANKY_DISCORD_CREDENTIAL_KIND must be bot-token or user-token");
}

export function parseDiscordBridgeCommand(text: string): DiscordBridgeCommand | undefined {
	const trimmed = text.trim();
	if (trimmed.length === 0) return undefined;
	const lower = trimmed.toLowerCase();
	if (lower === "/new" || lower === "/reset") return { type: "new" };
	if (lower === "/compact" || lower === "/summarize" || lower === "/summarise") return { type: "compact" };
	for (const standalone of ["/compact", "/summarize", "/summarise"]) {
		if (lower.startsWith(`${standalone} `)) {
			const customInstructions = trimmed.slice(standalone.length).trim();
			return customInstructions.length === 0 ? { type: "compact" } : { type: "compact", customInstructions };
		}
	}
	const prefix = DISCORD_BRIDGE_COMMAND_PREFIXES.find(
		(candidate) => lower === candidate || lower.startsWith(`${candidate} `),
	);
	if (prefix === undefined) return undefined;
	const rest = trimmed.slice(prefix.length).trim();
	if (rest.length === 0) return { type: "help" };
	const split = rest.match(/^(\S+)(?:\s+([\s\S]*))?$/u);
	const command = split?.[1]?.toLowerCase() ?? "";
	const args = split?.[2]?.trim() ?? "";

	if (command === "help" || command === "commands") return { type: "help" };
	if (command === "new" || command === "reset") return { type: "new" };
	if (command === "compact" || command === "summarize" || command === "summarise") {
		return args.length === 0 ? { type: "compact" } : { type: "compact", customInstructions: args };
	}
	if (
		command === "direct" ||
		command === "main" ||
		command === "ask" ||
		command === "talk" ||
		command === "no-subagent" ||
		command === "nosubagent" ||
		command === "skip-subagent" ||
		command === "skip_subagent"
	) {
		return { type: "direct", prompt: args };
	}

	return { type: "direct", prompt: rest };
}

function discordBridgeCommandHelpText(): string {
	return [
		"Discord Clanky commands:",
		"- Normal accepted Discord chat goes to the dedicated Discord subagent.",
		"- /clanky <message> or /clanky direct <message>: send this turn straight to main Clanky.",
		"- /clanky new: start a new main Clanky session.",
		"- /clanky compact [focus]: compact the main Clanky context.",
		"Aliases: /clank, !clanky, !clank, /new, /compact.",
	].join("\n");
}

export function evaluateDiscordMessageAcceptance(
	message: DiscordInboundMessage,
	config: ClankyAgentDiscordGatewayConfig,
	options: {
		isEngaged: (channelId: string, userId: string) => boolean;
		isKnownSelfMessage: (messageId: string) => boolean;
		wakeNames?: readonly string[];
	},
): DiscordAcceptanceDecision {
	if (config.conversationId !== undefined) {
		const matched =
			message.conversation.id === config.conversationId ||
			message.conversation.threadId === config.conversationId ||
			message.conversation.parentId === config.conversationId;
		return matched
			? { accepted: true, reason: "bound_conversation", recordInboundEngagement: true }
			: { accepted: false, reason: "not_engaged_no_mention" };
	}

	if (message.conversation.kind === "dm") return { accepted: true, reason: "dm", recordInboundEngagement: true };
	if (message.mentionsSelf) return { accepted: true, reason: "platform_mention", recordInboundEngagement: true };
	if (message.replyToExternalMessageId !== undefined && options.isKnownSelfMessage(message.replyToExternalMessageId)) {
		return { accepted: true, reason: "reply_to_self", recordInboundEngagement: true };
	}

	const wakeMatch = resolveWakeNameMatch(message.text, options.wakeNames ?? DEFAULT_DISCORD_WAKE_NAMES);
	if (wakeMatch.addressed) {
		return { accepted: true, reason: "name_address", recordInboundEngagement: true };
	}
	if (wakeMatch.mentioned) {
		return { accepted: true, reason: "name_mention", recordInboundEngagement: true };
	}

	// Engagement window: after a real engagement in this channel/thread, listen
	// to short follow-ups without requiring another @mention. A follow-up only
	// extends the window again if Clanky actually replies.
	if (options.isEngaged(message.conversation.id, message.sender.id)) {
		return { accepted: true, reason: "recent_engagement", recordInboundEngagement: false };
	}

	return { accepted: false, reason: "not_engaged_no_mention" };
}

export function formatDiscordUserMessage(
	message: DiscordInboundMessage,
	reason: DiscordAcceptanceReason,
	history: DiscordConversationHistoryEntry[] = [],
	metadata: DiscordConversationPromptMetadata = conversationPromptMetadata(message),
	imageReferences: DiscordPromptImageReference[] = [],
): string {
	const sender = message.sender.displayName ?? message.sender.username ?? message.sender.id;
	const attachmentLines = message.attachments
		.map((attachment) => attachment.url ?? attachment.filename)
		.filter((value): value is string => value !== undefined && value.trim().length > 0)
		.map((value) => `- ${value}`);
	const attachments = attachmentLines.length > 0 ? `\nAttachments:\n${attachmentLines.join("\n")}` : "";
	const text = message.text.trim() || "(no text)";
	const historyBlock = formatDiscordConversationHistory(history);
	return [
		"Discord conversation update:",
		"",
		"You are participating in an ongoing Discord chat. Zoom out before replying: use the recent context, the newest message, and any tool actions you perform in this turn to decide whether the channel needs another visible message from you.",
		"",
		`Bridge context: ${formatAcceptanceReasonForPrompt(reason)}`,
		"If no additional visible Discord response is needed, output exactly [SKIP].",
		"If you use a Discord send/upload tool for the current channel and that action already satisfies the user, output exactly [SKIP] as your final response instead of posting a duplicate confirmation.",
		"Only reply with text when it adds something useful beyond actions already taken.",
		"",
		"Discord conversation:",
		`- kind: ${metadata.conversationKind}`,
		`- conversationId: ${metadata.conversationId}`,
		`- channelOrThreadId: ${metadata.threadId ?? metadata.conversationId}`,
		...(metadata.serverId === undefined ? [] : [`- serverId: ${metadata.serverId}`]),
		...(metadata.threadId === undefined ? [] : [`- threadId: ${metadata.threadId}`]),
		...(metadata.parentId === undefined ? [] : [`- parentId: ${metadata.parentId}`]),
		...(metadata.displayName === undefined ? [] : [`- displayName: ${metadata.displayName}`]),
		`- newestMessageId: ${metadata.messageId}`,
		"If the user asks about Discord history beyond the messages shown here, use discord_read_messages with channelOrThreadId before answering.",
		"If the conversation calls for inspecting Discord media that is not already listed as visual input, use discord_recent_attachments with channelOrThreadId and messageId when targeting a specific message; only claim visual inspection when it returns loadedImages/image blocks.",
		"",
		...(imageReferences.length > 0
			? [
					"Visual attachments included with this turn (actual image pixels are attached to this model request):",
					...imageReferences.map(
						(reference) => `- image ${reference.index}: ${reference.label} (${reference.mimeType})`,
					),
					"",
				]
			: []),
		...(historyBlock.length > 0 ? ["Recent chat before the newest message:", historyBlock, ""] : []),
		"Newest Discord message:",
		`From: ${sender}`,
		`Text: ${text}`,
		attachments,
	]
		.filter((line) => line.length > 0)
		.join("\n");
}

function formatDiscordConversationHistory(history: DiscordConversationHistoryEntry[]): string {
	return history
		.slice(-MAX_CONVERSATION_HISTORY_MESSAGES)
		.map((entry) => {
			const suffix = entry.attachmentLabels.length > 0 ? ` [attachments: ${entry.attachmentLabels.join(", ")}]` : "";
			return `- ${entry.author}: ${entry.text}${suffix}`;
		})
		.join("\n");
}

function formatAcceptanceReasonForPrompt(reason: DiscordAcceptanceReason): string {
	switch (reason) {
		case "bound_conversation":
			return "This profile is bound to the current Discord conversation.";
		case "dm":
			return "This is a Discord DM.";
		case "discord_command":
			return "The message used a Discord bridge command that bypasses the subagent and goes straight to main Clanky.";
		case "platform_mention":
			return "The message directly @mentioned you.";
		case "reply_to_self":
			return "The message replied to one of your recent Discord messages.";
		case "name_address":
			return "The message addressed you by name without a Discord @mention.";
		case "name_mention":
			return "The message mentioned your name without a Discord @mention; decide whether it is actually inviting you in.";
		case "recent_engagement":
			return "This is a follow-up from the same user in a recent active Discord exchange.";
	}
}

export function isDiscordSkipReplyText(text: string): boolean {
	return /^\[SKIP\]$/i.test(text.trim());
}

function resolveWakeNameMatch(text: string, wakeNames: readonly string[]): { addressed: boolean; mentioned: boolean } {
	const names = dedupeWakeNames(wakeNames);
	for (const name of names) {
		if (isBotNameAddressed({ transcript: text, botName: name })) return { addressed: true, mentioned: true };
		if (containsWakeNameMention({ transcript: text, botName: name })) return { addressed: false, mentioned: true };
	}
	return { addressed: false, mentioned: false };
}

function isBotNameAddressed({ transcript, botName = "" }: { transcript: string; botName?: string }): boolean {
	const transcriptTokens = tokenizeWakeTokens(transcript);
	if (transcriptTokens.length === 0) return false;

	const botTokens = tokenizeWakeTokens(botName);
	if (botTokens.length === 0) return false;
	if (botTokens.length === 1) {
		return hasSingleTokenWakeAddress({
			transcript,
			transcriptTokens,
			wakeToken: botTokens[0] ?? "",
		});
	}
	if (containsTokenSequence(transcriptTokens, botTokens)) return true;
	const mergedWakeToken = resolveMergedWakeToken(botTokens);
	if (mergedWakeToken !== null && transcriptTokens.some((token) => token === mergedWakeToken)) return true;

	const primaryWakeToken = resolvePrimaryWakeToken(botTokens);
	if (primaryWakeToken === null) return false;
	return hasSingleTokenWakeAddress({
		transcript,
		transcriptTokens,
		wakeToken: primaryWakeToken,
	});
}

function containsWakeNameMention({ transcript, botName = "" }: { transcript: string; botName?: string }): boolean {
	const transcriptTokens = tokenizeWakeTokens(transcript);
	if (transcriptTokens.length === 0) return false;
	const botTokens = tokenizeWakeTokens(botName);
	if (botTokens.length === 0) return false;
	if (containsTokenSequence(transcriptTokens, botTokens)) return true;
	const mergedWakeToken = resolveMergedWakeToken(botTokens);
	if (mergedWakeToken !== null && transcriptTokens.some((token) => token === mergedWakeToken)) return true;
	if (botTokens.length === 1) {
		const token = botTokens[0] ?? "";
		return token.length >= PRIMARY_WAKE_TOKEN_MIN_LEN && !EN_WAKE_PRIMARY_GENERIC_TOKENS.has(token)
			? transcriptTokens.some((candidate) => candidate === token)
			: false;
	}
	return false;
}

function tokenizeWakeTokens(value = ""): string[] {
	const normalized = normalizeWakeText(value);
	const matches = normalized.match(/[\p{L}\p{N}]+/gu);
	return Array.isArray(matches) ? matches : [];
}

function normalizeWakeText(value = ""): string {
	return value
		.trim()
		.toLowerCase()
		.normalize("NFKD")
		.replace(/\p{M}+/gu, "");
}

function containsTokenSequence(tokens: string[] = [], sequence: string[] = []): boolean {
	if (tokens.length === 0 || sequence.length === 0 || sequence.length > tokens.length) return false;
	for (let start = 0; start <= tokens.length - sequence.length; start += 1) {
		let matched = true;
		for (let index = 0; index < sequence.length; index += 1) {
			if (tokens[start + index] !== sequence[index]) {
				matched = false;
				break;
			}
		}
		if (matched) return true;
	}
	return false;
}

function resolvePrimaryWakeToken(botTokens: string[] = []): string | null {
	const candidates = botTokens.filter((token) => token.length >= PRIMARY_WAKE_TOKEN_MIN_LEN);
	if (candidates.length === 0) return null;
	const preferred = candidates.find((token) => !EN_WAKE_PRIMARY_GENERIC_TOKENS.has(token));
	return preferred ?? candidates[0] ?? null;
}

function resolveMergedWakeToken(botTokens: string[] = []): string | null {
	if (botTokens.length < 2) return null;
	const merged = botTokens.join("");
	return merged.length >= PRIMARY_WAKE_TOKEN_MIN_LEN ? merged : null;
}

function hasSingleTokenWakeAddress({
	transcript,
	transcriptTokens,
	wakeToken,
}: {
	transcript: string;
	transcriptTokens: string[];
	wakeToken: string;
}): boolean {
	const normalizedWakeToken = wakeToken.trim().toLowerCase();
	if (normalizedWakeToken.length === 0) return false;
	if (hasLeadingWakeToken(transcriptTokens, normalizedWakeToken)) return true;
	return hasVocativeWakeToken(transcript, normalizedWakeToken);
}

function hasLeadingWakeToken(tokens: string[] = [], wakeToken = ""): boolean {
	if (tokens.length === 0 || wakeToken.length === 0) return false;
	let index = 0;
	while (index < tokens.length && LEADING_WAKE_PREFIX_TOKENS.has(tokens[index] ?? "")) {
		index += 1;
	}
	return tokens[index] === wakeToken;
}

function hasVocativeWakeToken(transcript = "", wakeToken = ""): boolean {
	const normalizedTranscript = normalizeWakeText(transcript);
	if (normalizedTranscript.length === 0 || wakeToken.length === 0) return false;
	const escapedWakeToken = escapeRegex(wakeToken);
	return new RegExp(`[,;:.!?]\\s*${escapedWakeToken}(?:\\b|')`, "u").test(normalizedTranscript);
}

function escapeRegex(value = ""): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function extractAssistantText(event: AgentSessionEvent): string | undefined {
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
