import { appendFile } from "node:fs/promises";
import { DiscordChatGatewayProvider, type DiscordGatewayClient } from "@agentroom/chat-discord";
import {
	type ClankyDiscordCredentialKind,
	DEFAULT_CLANKY_DISCORD_PROVIDER_ID,
	type DiscordSubagentStore,
	loadStoredDiscordCredential,
	shouldStartAgentChatGateway,
} from "@clanky/core";
import type {
	AgentSessionEvent,
	AgentSessionRuntime,
	AuthStorage,
	CreateAgentSessionRuntimeFactory,
} from "@earendil-works/pi-coding-agent";
import { createAgentDiscordClient } from "./agentDiscordClient.ts";
import { DiscordSubagentCoordinator } from "./discordSubagentCoordinator.ts";
import { type RuntimeTurnQueue, SerialRuntimeTurnQueue } from "./runtimeTurnQueue.ts";

type DiscordCredentialKind = ClankyDiscordCredentialKind;

export interface DiscordInboundConversation {
	id: string;
	kind: "dm" | "channel" | "group" | "thread" | "custom";
	threadId?: string;
	parentId?: string;
	guildId?: string;
	displayName?: string;
}

export interface DiscordInboundSender {
	id: string;
	username?: string;
	displayName?: string;
	isBot?: boolean;
}

export interface DiscordInboundAttachment {
	url?: string;
	filename?: string;
}

export interface DiscordInboundMessage {
	externalMessageId: string;
	conversation: DiscordInboundConversation;
	sender: DiscordInboundSender;
	text: string;
	attachments: DiscordInboundAttachment[];
	mentionsSelf: boolean;
	replyToExternalMessageId?: string;
}

export type ClankyAgentDiscordGatewayConfigSource = "env" | "stored";

export interface ClankyAgentDiscordGatewayConfig {
	providerId: string;
	token: string;
	credentialKind: DiscordCredentialKind;
	conversationId?: string;
	source: ClankyAgentDiscordGatewayConfigSource;
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
	messageId?: string;
}

const DEFAULT_ENGAGEMENT_WINDOW_MS = 5 * 60 * 1000;
const DEFAULT_DISCORD_WAKE_NAMES = ["clanky", "clank"];
const MAX_TRACKED_SELF_MESSAGES = 200;
const MAX_CONVERSATION_HISTORY_MESSAGES = 8;
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
	const raw = env.CLANKY_DISCORD_WAKE_NAMES?.trim();
	if (raw === undefined || raw.length === 0) return DEFAULT_DISCORD_WAKE_NAMES;
	const configured = raw
		.split(",")
		.map((value) => value.trim())
		.filter((value) => value.length > 0);
	return configured.length > 0 ? configured : DEFAULT_DISCORD_WAKE_NAMES;
}

export interface ClankyAgentDiscordGatewayHandle {
	readonly client: DiscordGatewayClient;
	stop(): Promise<void>;
}

/**
 * Resolve the Discord gateway config.
 *
 * Precedence:
 *  1. Owner gate. If `CLANKY_CHAT_GATEWAY_OWNER` resolves to `room` or
 *     `off` the agent-owned gateway is suppressed entirely.
 *  2. `CLANKY_DISCORD_TOKEN` env (matches the existing Linear creds
 *     pattern — env always wins over stored). Companion env vars
 *     `CLANKY_DISCORD_CREDENTIAL_KIND`, `CLANKY_DISCORD_PROVIDER_ID`,
 *     `CLANKY_DISCORD_CONVERSATION_ID` (or legacy
 *     `CLANKY_DISCORD_CHANNEL_ID`) take effect when env is the source.
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
	return resolveAgentDiscordCredentialConfig(env, authStorage);
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
): ClankyAgentDiscordGatewayConfig | undefined {
	const providerId = env.CLANKY_DISCORD_PROVIDER_ID?.trim() || DEFAULT_CLANKY_DISCORD_PROVIDER_ID;
	const envConversationId =
		env.CLANKY_DISCORD_CONVERSATION_ID?.trim() || env.CLANKY_DISCORD_CHANNEL_ID?.trim() || undefined;
	const envCredentialKindRaw = env.CLANKY_DISCORD_CREDENTIAL_KIND?.trim();

	const envToken = env.CLANKY_DISCORD_TOKEN?.trim();
	if (envToken !== undefined && envToken.length > 0) {
		const credentialKind = parseDiscordCredentialKind(envCredentialKindRaw);
		const config: ClankyAgentDiscordGatewayConfig = {
			providerId,
			token: envToken,
			credentialKind,
			source: "env",
		};
		if (envConversationId !== undefined) config.conversationId = envConversationId;
		return config;
	}

	if (authStorage === undefined) return undefined;
	const stored = loadStoredDiscordCredential(authStorage, providerId);
	if (stored === undefined) return undefined;

	const credentialKind =
		envCredentialKindRaw !== undefined && envCredentialKindRaw.length > 0
			? parseDiscordCredentialKind(envCredentialKindRaw)
			: stored.payload.credentialKind;
	const conversationId = envConversationId ?? stored.payload.conversationId;
	const config: ClankyAgentDiscordGatewayConfig = {
		providerId: stored.providerId,
		token: stored.payload.token,
		credentialKind,
		source: "stored",
	};
	if (conversationId !== undefined) config.conversationId = conversationId;
	return config;
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
	subagentStore?: DiscordSubagentStore;
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
		ignoreBotMessages: true,
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
	subagents?: DiscordSubagentCoordinator;
	bridgeLogPath?: string;
}

export type DiscordAcceptanceReason =
	| "bound_conversation"
	| "dm"
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
	private readonly provider: DiscordChatGatewayProvider;
	private readonly config: ClankyAgentDiscordGatewayConfig;
	private readonly options: AgentDiscordBridgeOptions;
	private readonly runtimeTurnQueue: RuntimeTurnQueue;
	private readonly subagents: DiscordSubagentCoordinator | undefined;
	private unsubscribe: (() => void) | undefined;
	private subscribedSession: AgentSessionRuntime["session"];
	private readonly pendingReplies: PendingDiscordReply[] = [];
	/** Per (channelId, userId) most-recent engagement timestamp (ms). */
	private readonly engagements = new Map<string, number>();
	private readonly inboundReceivedAt = new Map<string, number>();
	private readonly recentConversationMessages = new Map<string, DiscordConversationHistoryEntry[]>();
	private readonly selfMessageIds = new Set<string>();
	private readonly selfMessageIdOrder: string[] = [];

	constructor(
		runtime: AgentSessionRuntime,
		provider: DiscordChatGatewayProvider,
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
		this.subscribedSession = runtime.session;
	}

	async start(): Promise<void> {
		this.subscribeToCurrentSession();
		await this.provider.start(async (rawMessage: unknown) => {
			const message = rawMessage as DiscordInboundMessage;
			const t1 = Date.now();
			const channelId = message.conversation.id;
			const senderId = message.sender.id;
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
			if (this.subagents !== undefined) {
				await this.subagents.enqueue(message, decision.reason);
				this.logBridge(`queued-for-subagent ext=${message.externalMessageId} channel=${channelId}`);
				return;
			}
			const pending: PendingDiscordReply = {
				conversation: message.conversation,
				replyToExternalMessageId: message.externalMessageId,
				senderId,
				channelId,
				acceptanceReason: decision.reason,
			};
			await this.runtimeTurnQueue.enqueue(async () => {
				this.subscribeToCurrentSession();
				const userPrompt = this.formatDiscordUserMessage(message, decision.reason);
				this.recordInboundMessage(message);
				this.pendingReplies.push(pending);
				try {
					await this.runtime.session.sendUserMessage(userPrompt);
				} catch (error) {
					this.removePendingReply(pending);
					this.inboundReceivedAt.delete(message.externalMessageId);
					throw error;
				}
				this.logBridge(`forwarded-to-pi ext=${message.externalMessageId} dt=${Date.now() - t1}ms`);
			});
		});
		await this.subagents?.start();
	}

	async stop(): Promise<void> {
		this.unsubscribe?.();
		this.unsubscribe = undefined;
		await this.subagents?.stop();
		await this.provider.stop();
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
		this.recordAssistantMessage(pending.channelId, sent.externalMessageId, text);
		this.recordEngagement(pending.channelId, pending.senderId);
		this.logBridge(
			`discord-sent ext=${pending.replyToExternalMessageId} reply-id=${sent.externalMessageId} send-dt=${
				Date.now() - t3
			}ms${t1 !== undefined ? ` total=${Date.now() - t1}ms` : ""} reason=${pending.acceptanceReason}`,
		);
	}

	private isEngaged(channelId: string, userId: string): boolean {
		if (this.options.engagementWindowMs <= 0) return false;
		const last = this.engagements.get(engagementKey(channelId, userId));
		if (last === undefined) return false;
		return Date.now() - last < this.options.engagementWindowMs;
	}

	private recordEngagement(channelId: string, userId: string): void {
		if (this.options.engagementWindowMs <= 0) return;
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
		return dedupeWakeNames([...clientNames, ...this.options.wakeNames]);
	}

	private formatDiscordUserMessage(message: DiscordInboundMessage, reason: DiscordAcceptanceReason): string {
		const history = this.recentConversationMessages.get(message.conversation.id) ?? [];
		return formatDiscordUserMessage(message, reason, history);
	}

	private recordInboundMessage(message: DiscordInboundMessage): void {
		const author = message.sender.displayName ?? message.sender.username ?? message.sender.id;
		this.recordConversationMessage(message.conversation.id, {
			author,
			text: message.text.trim() || "(no text)",
			attachmentLabels: message.attachments
				.map((attachment) => attachment.filename ?? attachment.url)
				.filter((value): value is string => value !== undefined && value.trim().length > 0),
			messageId: message.externalMessageId,
		});
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

function parseDiscordCredentialKind(value: string | undefined): DiscordCredentialKind {
	if (value === undefined || value === "") return "bot-token";
	if (value === "bot-token" || value === "user-token") return value;
	throw new Error("CLANKY_DISCORD_CREDENTIAL_KIND must be bot-token or user-token");
}

export function shouldAcceptDiscordMessage(
	message: DiscordInboundMessage,
	config: ClankyAgentDiscordGatewayConfig,
	isEngaged: (channelId: string, userId: string) => boolean,
): boolean {
	return evaluateDiscordMessageAcceptance(message, config, {
		isEngaged,
		isKnownSelfMessage: () => false,
		wakeNames: DEFAULT_DISCORD_WAKE_NAMES,
	}).accepted;
}

export function evaluateDiscordMessageAcceptance(
	message: DiscordInboundMessage,
	config: ClankyAgentDiscordGatewayConfig,
	options: {
		isEngaged: (channelId: string, userId: string) => boolean;
		isKnownSelfMessage: (messageId: string) => boolean;
		wakeNames?: string[];
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

	// Engagement window: after a real engagement in this channel, listen to
	// same-user follow-ups without requiring another @mention. A follow-up only
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

function resolveWakeNameMatch(text: string, wakeNames: string[]): { addressed: boolean; mentioned: boolean } {
	const names = dedupeWakeNames(wakeNames);
	for (const name of names) {
		if (isBotNameAddressed({ transcript: text, botName: name })) return { addressed: true, mentioned: true };
		if (containsWakeNameMention({ transcript: text, botName: name })) return { addressed: false, mentioned: true };
	}
	return { addressed: false, mentioned: false };
}

function dedupeWakeNames(values: string[]): string[] {
	const out: string[] = [];
	const seen = new Set<string>();
	for (const value of values) {
		const normalized = value.replace(/\s+/g, " ").trim();
		const key = normalizeWakeText(normalized);
		if (normalized.length === 0 || key.length === 0 || seen.has(key)) continue;
		seen.add(key);
		out.push(normalized);
	}
	return out;
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
