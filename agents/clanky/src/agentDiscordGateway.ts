import { DiscordChatGatewayProvider } from "@agentroom/chat-discord";
import { shouldStartAgentChatGateway } from "@clanky/core";
import type { AgentSessionEvent, AgentSessionRuntime } from "@earendil-works/pi-coding-agent";

type DiscordCredentialKind = "bot-token" | "user-token";
type DiscordInboundHandler = Parameters<DiscordChatGatewayProvider["start"]>[0];
type DiscordInboundMessage = Parameters<DiscordInboundHandler>[0];

export interface ClankyAgentDiscordGatewayConfig {
	providerId: string;
	token: string;
	credentialKind: DiscordCredentialKind;
	conversationId?: string;
}

interface PendingDiscordReply {
	conversation: DiscordInboundMessage["conversation"];
	replyToExternalMessageId: string;
}

export interface ClankyAgentDiscordGatewayHandle {
	stop(): Promise<void>;
}

export function resolveAgentDiscordGatewayConfig(
	env: NodeJS.ProcessEnv = process.env,
): ClankyAgentDiscordGatewayConfig | undefined {
	if (!shouldStartAgentChatGateway(env)) return undefined;

	const token = env.CLANKY_DISCORD_TOKEN?.trim();
	if (!token) return undefined;

	const rawCredentialKind = env.CLANKY_DISCORD_CREDENTIAL_KIND?.trim();
	const credentialKind = parseDiscordCredentialKind(rawCredentialKind);
	const providerId = env.CLANKY_DISCORD_PROVIDER_ID?.trim() || "clanky-discord";
	const conversationId =
		env.CLANKY_DISCORD_CONVERSATION_ID?.trim() || env.CLANKY_DISCORD_CHANNEL_ID?.trim() || undefined;

	return {
		providerId,
		token,
		credentialKind,
		...(conversationId !== undefined ? { conversationId } : {}),
	};
}

export async function startAgentDiscordGateway(input: {
	runtime: AgentSessionRuntime;
	config?: ClankyAgentDiscordGatewayConfig;
}): Promise<ClankyAgentDiscordGatewayHandle | undefined> {
	const config = input.config ?? resolveAgentDiscordGatewayConfig();
	if (config === undefined) return undefined;

	const provider = new DiscordChatGatewayProvider({
		id: config.providerId,
		token: config.token,
		credentialKind: config.credentialKind,
		ignoreBotMessages: true,
	});
	const bridge = new AgentDiscordBridge(input.runtime, provider, config);
	await bridge.start();
	return bridge;
}

class AgentDiscordBridge implements ClankyAgentDiscordGatewayHandle {
	private readonly runtime: AgentSessionRuntime;
	private readonly provider: DiscordChatGatewayProvider;
	private readonly config: ClankyAgentDiscordGatewayConfig;
	private unsubscribe: (() => void) | undefined;
	private subscribedSession: AgentSessionRuntime["session"];
	private readonly pendingReplies: PendingDiscordReply[] = [];

	constructor(
		runtime: AgentSessionRuntime,
		provider: DiscordChatGatewayProvider,
		config: ClankyAgentDiscordGatewayConfig,
	) {
		this.runtime = runtime;
		this.provider = provider;
		this.config = config;
		this.subscribedSession = runtime.session;
	}

	async start(): Promise<void> {
		this.subscribeToCurrentSession();
		await this.provider.start(async (message) => {
			if (!shouldAcceptDiscordMessage(message, this.config)) return;
			this.subscribeToCurrentSession();
			this.pendingReplies.push({
				conversation: message.conversation,
				replyToExternalMessageId: message.externalMessageId,
			});
			await this.runtime.session.sendUserMessage(formatDiscordUserMessage(message));
		});
	}

	async stop(): Promise<void> {
		this.unsubscribe?.();
		this.unsubscribe = undefined;
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

		await this.provider.sendMessage({
			conversation: pending.conversation,
			replyToExternalMessageId: pending.replyToExternalMessageId,
			text,
		});
	}
}

function parseDiscordCredentialKind(value: string | undefined): DiscordCredentialKind {
	if (value === undefined || value === "") return "bot-token";
	if (value === "bot-token" || value === "user-token") return value;
	throw new Error("CLANKY_DISCORD_CREDENTIAL_KIND must be bot-token or user-token");
}

function shouldAcceptDiscordMessage(message: DiscordInboundMessage, config: ClankyAgentDiscordGatewayConfig): boolean {
	if (config.conversationId !== undefined) {
		return (
			message.conversation.id === config.conversationId ||
			message.conversation.threadId === config.conversationId ||
			message.conversation.parentId === config.conversationId
		);
	}

	return message.conversation.kind === "dm" || message.mentionsSelf;
}

function formatDiscordUserMessage(message: DiscordInboundMessage): string {
	const sender = message.sender.displayName ?? message.sender.username ?? message.sender.id;
	const attachmentLines = message.attachments
		.map((attachment) => attachment.url ?? attachment.filename)
		.filter((value): value is string => value !== undefined && value.trim().length > 0)
		.map((value) => `- ${value}`);
	const attachments = attachmentLines.length > 0 ? `\n\nAttachments:\n${attachmentLines.join("\n")}` : "";
	const text = message.text.trim() || "(no text)";
	return `Discord message from ${sender}:\n\n${text}${attachments}`;
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
