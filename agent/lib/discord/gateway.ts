/**
 * Clanky's Discord Gateway client — the always-on ear (SPEC.md §5.2/§5.3).
 *
 * eve's stock discord.ts is HTTP Interactions only. Free-will presence needs to
 * read every message in a channel, which requires a persistent Gateway
 * connection. This wraps discord.js for: inbound message events (normalized to
 * the credential-free DiscordInboundMessage the acceptance gate consumes),
 * outbound REST sends (stateless bot-token POSTs, so a presence session can post
 * its own replies), typing indicators, and self-message tracking for
 * reply-to-self detection. The underlying client is exposed so the voice runtime
 * can drive voice-state joins atop the same connection.
 *
 * Credentials come from the eve agent's environment / connection config; nothing
 * is committed.
 */
import { Client, Events, GatewayIntentBits, type Attachment, type Embed, type Message, Partials } from "discord.js";
import type { DiscordRawGatewayClient } from "../voice/discordStreamDiscovery.ts";
import type {
	DiscordConversationKind,
	DiscordInboundAttachment,
	DiscordInboundEmbed,
	DiscordInboundMessage,
} from "./acceptance.ts";
import { applyDiscordUserTokenPatches } from "./user-token-patches.ts";

const DISCORD_MAX_MESSAGE_CHARS = 2000;
const SELF_MESSAGE_MEMORY = 500;

/** A bot token (the default) or a user/self token (selfbot, for Go Live). */
export type DiscordCredentialKind = "bot-token" | "user-token";

export function resolveDiscordCredentialKind(env: NodeJS.ProcessEnv): DiscordCredentialKind {
	return env.CLANKY_DISCORD_CREDENTIAL_KIND === "user-token" ? "user-token" : "bot-token";
}

/**
 * The agent-owned Discord token, shared by the presence gateway, REST tools, and
 * media downloads so they never disagree on which credential to use.
 */
export function resolveDiscordToken(env: NodeJS.ProcessEnv = process.env): string | undefined {
	const token = env.CLANKY_DISCORD_TOKEN?.trim() || env.DISCORD_BOT_TOKEN?.trim();
	return token !== undefined && token.length > 0 ? token : undefined;
}

export interface DiscordGatewayOptions {
	token: string;
	/** Bot token (default) or user/self token. User tokens unlock Go Live. */
	credentialKind?: DiscordCredentialKind;
	/** Include voice-state intent so "hop in vc" and the media plane can join. */
	voice?: boolean;
	/** Include DM + message-content intents for free-will text presence. */
	chat?: boolean;
}

export type DiscordInboundHandler = (message: DiscordInboundMessage) => void | Promise<void>;

/** Split a reply into Discord's 2000-char-limited chunks on line boundaries. */
export function chunkDiscordMessage(text: string, limit: number = DISCORD_MAX_MESSAGE_CHARS): string[] {
	const trimmed = text.trim();
	if (trimmed.length === 0) return [];
	if (trimmed.length <= limit) return [trimmed];
	const chunks: string[] = [];
	let current = "";
	for (const line of trimmed.split("\n")) {
		const piece = line.length > limit ? line.slice(0, limit) : line;
		if (current.length + piece.length + 1 > limit) {
			if (current.length > 0) chunks.push(current);
			current = piece;
		} else {
			current = current.length === 0 ? piece : `${current}\n${piece}`;
		}
	}
	if (current.length > 0) chunks.push(current);
	return chunks;
}

function conversationKind(message: Message): DiscordConversationKind {
	if (message.guildId === null) return "dm";
	if (message.channel.isThread()) return "thread";
	return "channel";
}

export class DiscordGateway {
	private readonly client: Client;
	private readonly token: string;
	private readonly credentialKind: DiscordCredentialKind;
	/** Recently-sent message ids, for reply-to-self detection (bounded FIFO). */
	private readonly selfMessageIds: string[] = [];
	private readonly selfMessageSet = new Set<string>();
	private ready = false;

	constructor(options: DiscordGatewayOptions) {
		this.token = options.token;
		this.credentialKind = options.credentialKind ?? "bot-token";
		const intents = [GatewayIntentBits.Guilds];
		if (options.chat !== false) {
			intents.push(
				GatewayIntentBits.GuildMessages,
				GatewayIntentBits.DirectMessages,
				GatewayIntentBits.MessageContent,
			);
		}
		if (options.voice === true) intents.push(GatewayIntentBits.GuildVoiceStates);
		this.client = new Client({ intents, partials: [Partials.Channel, Partials.Message] });
	}

	/** The bot's own user id once connected, for self-message filtering. */
	get selfUserId(): string | undefined {
		return this.client.user?.id;
	}

	/** Underlying discord.js client, for the voice runtime's voice-state joins. */
	get discordClient(): Client {
		return this.client;
	}

	/** Raw-gateway view for Go Live stream discovery (op send + raw dispatch). */
	rawGatewayClient(): DiscordRawGatewayClient {
		return this.client as unknown as DiscordRawGatewayClient;
	}

	isKnownSelfMessage(messageId: string): boolean {
		return this.selfMessageSet.has(messageId);
	}

	private rememberSelfMessage(messageId: string): void {
		if (this.selfMessageSet.has(messageId)) return;
		this.selfMessageSet.add(messageId);
		this.selfMessageIds.push(messageId);
		while (this.selfMessageIds.length > SELF_MESSAGE_MEMORY) {
			const evicted = this.selfMessageIds.shift();
			if (evicted !== undefined) this.selfMessageSet.delete(evicted);
		}
	}

	private normalize(message: Message): DiscordInboundMessage {
		const channel = message.channel;
		const isThread = channel.isThread();
		return {
			externalMessageId: message.id,
			channelId: message.channelId,
			threadId: isThread ? channel.id : undefined,
			parentId: isThread ? (channel.parentId ?? undefined) : undefined,
			guildId: message.guildId ?? undefined,
			authorId: message.author.id,
			authorName: message.member?.displayName ?? message.author.globalName ?? message.author.username,
			authorIsBot: message.author.bot,
			text: message.content,
			kind: conversationKind(message),
			mentionsSelf: this.client.user !== null && message.mentions.users.has(this.client.user.id),
			replyToExternalMessageId: message.reference?.messageId ?? undefined,
			attachments: [...message.attachments.values()].map(normalizeAttachment),
			embeds: message.embeds.map(normalizeEmbed),
		};
	}

	async start(handler: DiscordInboundHandler): Promise<void> {
		this.client.on(Events.MessageCreate, (message) => {
			this.ready = true;
			void Promise.resolve(handler(this.normalize(message))).catch((error: unknown) => {
				console.error("discord inbound handler failed:", error);
			});
		});
		// User/self tokens need discord.js patched before login (no "Bot " prefix,
		// /gateway instead of /gateway/bot, synthetic READY application).
		if (this.credentialKind === "user-token") applyDiscordUserTokenPatches(this.client);
		await new Promise<void>((resolve, reject) => {
			this.client.once(Events.ClientReady, () => {
				this.ready = true;
				resolve();
			});
			this.client.once(Events.Error, reject);
			this.client.login(this.token).catch(reject);
		});
	}

	/** Send a reply to a channel via REST; returns the posted message ids. */
	async sendMessage(channelId: string, text: string): Promise<string[]> {
		const channel = await this.client.channels.fetch(channelId);
		if (channel === null || !channel.isSendable()) {
			throw new Error(`discord channel ${channelId} is not sendable`);
		}
		const ids: string[] = [];
		for (const chunk of chunkDiscordMessage(text)) {
			const sent = await channel.send({ content: chunk, allowedMentions: { parse: [] } });
			this.rememberSelfMessage(sent.id);
			ids.push(sent.id);
		}
		return ids;
	}

	async sendTyping(channelId: string): Promise<void> {
		const channel = await this.client.channels.fetch(channelId);
		if (channel !== null && channel.isTextBased() && "sendTyping" in channel) {
			await channel.sendTyping().catch(() => {});
		}
	}

	async fetchRecentMessages(channelId: string, limit = 5): Promise<DiscordInboundMessage[]> {
		const channel = await this.client.channels.fetch(channelId);
		if (channel === null || !channel.isTextBased() || !("messages" in channel)) return [];
		const messages = await channel.messages.fetch({ limit });
		return [...messages.values()].map((message) => this.normalize(message));
	}

	isReady(): boolean {
		return this.ready || this.client.isReady();
	}

	async stop(): Promise<void> {
		await this.client.destroy();
		this.ready = false;
	}
}

function normalizeAttachment(attachment: Attachment): DiscordInboundAttachment {
	return {
		id: attachment.id,
		url: attachment.url,
		filename: attachment.name,
		...(attachment.contentType === null ? {} : { contentType: attachment.contentType }),
		size: attachment.size,
		...(attachment.width === null ? {} : { width: attachment.width }),
		...(attachment.height === null ? {} : { height: attachment.height }),
		...(attachment.description === null ? {} : { description: attachment.description }),
	};
}

function normalizeEmbed(embed: Embed): DiscordInboundEmbed {
	return {
		...(embed.data.type === undefined ? {} : { type: embed.data.type }),
		...(embed.url === null ? {} : { url: embed.url }),
		...(embed.title === null ? {} : { title: embed.title }),
		...(embed.description === null ? {} : { description: embed.description }),
		...(embed.provider?.name === undefined ? {} : { provider: embed.provider.name }),
		...(embed.image?.url === undefined ? {} : { imageUrl: embed.image.url }),
		...(embed.thumbnail?.url === undefined ? {} : { thumbnailUrl: embed.thumbnail.url }),
		...(embed.video?.url === undefined ? {} : { videoUrl: embed.video.url }),
	};
}
