import {
	Client,
	type ClientOptions,
	type DMChannel,
	Events,
	GatewayIntentBits,
	type GuildTextBasedChannel,
	type Interaction,
	type Message,
	type MessageCreateOptions,
	Partials,
	REST,
	Routes,
	type Snowflake,
	type TextChannel,
} from "discord.js";
import { BasePlatformAdapter } from "../adapter.ts";
import { AllowList } from "../allowlist.ts";
import type { DiscordPlatformConfig } from "../config.ts";
import type {
	ChatType,
	EditOptions,
	MediaAttachment,
	MessageEvent,
	Platform,
	PlatformCapabilities,
	SendMediaOptions,
	SendOptions,
	SendResult,
} from "../types.ts";

const DISCORD_MAX_LENGTH = 2_000;

const SLASH_COMMANDS_INTERCEPTED = new Set([
	"new",
	"reset",
	"stop",
	"abort",
	"who_are_you",
	"what_do_you_remember",
	"why_did_you_say_that",
	"forget_me",
	"forget_this_channel",
	"memory_export",
	"memory_off",
	"privacy",
]);

export interface DiscordAdapterDeps {
	resetChatSession: (chatId: string, threadId?: string, userId?: string) => Promise<void>;
	abortChatSession?: (chatId: string, threadId?: string, userId?: string) => Promise<void>;
}

export interface DiscordAdapterOptions {
	config: DiscordPlatformConfig;
	deps?: DiscordAdapterDeps;
	clientOptions?: ClientOptions;
}

export class DiscordAdapter extends BasePlatformAdapter {
	readonly platform: Platform = "discord";
	readonly capabilities: PlatformCapabilities;

	private readonly client: Client;
	private readonly config: DiscordPlatformConfig;
	private readonly allowList: AllowList;
	private readonly deps: DiscordAdapterDeps | undefined;
	private botId: string | undefined;
	private ready = false;
	private destroyed = false;

	constructor(options: DiscordAdapterOptions) {
		super();
		this.config = options.config;
		this.deps = options.deps;
		this.allowList = new AllowList(options.config.allowList);
		this.capabilities = {
			maxMessageLength: Math.min(options.config.maxMessageLength, DISCORD_MAX_LENGTH),
			supportsEditing: true,
			supportsDeletion: true,
			supportsTyping: true,
			supportsImages: true,
			supportsVoice: options.config.voiceReceiveEnabled,
			supportsDocuments: true,
			supportsAnimations: true,
			supportsReactions: options.config.reactionProgressEnabled,
			supportsThreads: true,
			supportsForums: true,
			supportsSlashCommandSync: options.config.commandSyncPolicy !== "off",
			editRateLimitMs: options.config.editRateLimitMs,
		};
		if (options.config.botToken === undefined) {
			throw new Error("DiscordAdapter requires a botToken in config");
		}
		const clientOptions: ClientOptions = options.clientOptions ?? {
			intents: [
				GatewayIntentBits.Guilds,
				GatewayIntentBits.GuildMessages,
				GatewayIntentBits.GuildMessageReactions,
				GatewayIntentBits.MessageContent,
				GatewayIntentBits.DirectMessages,
				GatewayIntentBits.DirectMessageReactions,
			],
			partials: [Partials.Channel, Partials.Message],
		};
		this.client = new Client(clientOptions);
		this.client.on(Events.MessageCreate, (message) => {
			this.handleMessage(message).catch((error: unknown) => this.handleError(error));
		});
		this.client.on(Events.MessageUpdate, (_oldMessage, newMessage) => {
			if (newMessage.partial) return;
			this.handleMessage(newMessage as Message).catch((error: unknown) => this.handleError(error));
		});
		this.client.on(Events.InteractionCreate, (interaction) => {
			this.handleInteraction(interaction).catch((error: unknown) => this.handleError(error));
		});
		this.client.on(Events.Error, (error) => this.handleError(error));
		this.client.on(Events.ShardDisconnect, () => this.markDisconnected());
		this.client.on(Events.ShardReconnecting, () => this.markDisconnected());
		this.client.on(Events.ShardResume, () => this.markConnected());
	}

	async connect(): Promise<boolean> {
		try {
			await this.client.login(this.config.botToken);
			await this.waitForReady();
			this.botId = this.client.user?.id;
			this.markConnected();
			if (this.config.commandSyncPolicy === "auto") {
				await this.syncSlashCommands().catch((error: unknown) => this.handleError(error));
			}
			return true;
		} catch (error) {
			this.setFatalError("discord_login_failed", errorMessage(error), { retryable: true });
			return false;
		}
	}

	async disconnect(): Promise<void> {
		this.destroyed = true;
		try {
			await this.client.destroy();
		} catch {
			// ignore
		}
		this.markDisconnected();
	}

	async send(text: string, options: SendOptions): Promise<SendResult> {
		const channel = await this.fetchChannel(options.chatId, options.threadId);
		if (channel === undefined) throw new Error(`discord channel not found: ${options.chatId}`);
		const sendOpts: MessageCreateOptions = { content: truncateForDiscord(text) };
		if (options.replyToMessageId !== undefined) {
			sendOpts.reply = { messageReference: options.replyToMessageId, failIfNotExists: false };
		}
		if (!channel.isTextBased() || !("send" in channel)) {
			throw new Error(`discord channel ${options.chatId} is not text-based`);
		}
		try {
			const message = await (channel as TextChannel | DMChannel).send(sendOpts);
			return { messageId: message.id, chunked: text.length > DISCORD_MAX_LENGTH };
		} catch (error) {
			throw normalizeApiError(error);
		}
	}

	async editMessage(text: string, options: EditOptions): Promise<SendResult> {
		const channel = await this.fetchChannel(options.chatId, options.threadId);
		if (channel === undefined || !channel.isTextBased() || !("messages" in channel)) {
			throw new Error(`discord channel not found: ${options.chatId}`);
		}
		try {
			const message = await (channel as TextChannel | DMChannel).messages.fetch(options.messageId);
			await message.edit({ content: truncateForDiscord(text) });
			return { messageId: options.messageId, chunked: false };
		} catch (error) {
			throw normalizeApiError(error);
		}
	}

	async deleteMessage(chatId: string, messageId: string): Promise<boolean> {
		const channel = await this.fetchChannel(chatId);
		if (channel === undefined || !channel.isTextBased() || !("messages" in channel)) return false;
		try {
			await (channel as TextChannel | DMChannel).messages.delete(messageId);
			return true;
		} catch {
			return false;
		}
	}

	override async sendTyping(chatId: string, threadId?: string): Promise<void> {
		const channel = await this.fetchChannel(chatId, threadId);
		if (channel === undefined || !channel.isTextBased() || !("sendTyping" in channel)) return;
		try {
			await (channel as TextChannel).sendTyping();
		} catch {
			// best effort
		}
	}

	override async sendImage(options: SendMediaOptions): Promise<SendResult | undefined> {
		return await this.sendAttachment(options);
	}

	override async sendVideo(options: SendMediaOptions): Promise<SendResult | undefined> {
		return await this.sendAttachment(options);
	}

	override async sendDocument(options: SendMediaOptions): Promise<SendResult | undefined> {
		return await this.sendAttachment(options);
	}

	override async sendAnimation(options: SendMediaOptions): Promise<SendResult | undefined> {
		return await this.sendAttachment(options);
	}

	override async addReaction(chatId: string, messageId: string, emoji: string): Promise<boolean> {
		if (!this.config.reactionProgressEnabled) return false;
		const channel = await this.fetchChannel(chatId);
		if (channel === undefined || !channel.isTextBased() || !("messages" in channel)) return false;
		try {
			const message = await (channel as TextChannel | DMChannel).messages.fetch(messageId);
			await message.react(emoji);
			return true;
		} catch {
			return false;
		}
	}

	override async removeReaction(chatId: string, messageId: string, emoji: string): Promise<boolean> {
		if (!this.config.reactionProgressEnabled) return false;
		const channel = await this.fetchChannel(chatId);
		if (channel === undefined || !channel.isTextBased() || !("messages" in channel)) return false;
		try {
			const message = await (channel as TextChannel | DMChannel).messages.fetch(messageId);
			const reaction = message.reactions.cache.get(emoji);
			if (reaction === undefined) return true;
			await reaction.remove();
			return true;
		} catch {
			return false;
		}
	}

	private async sendAttachment(options: SendMediaOptions): Promise<SendResult | undefined> {
		const source = options.attachment.url ?? options.attachment.localPath;
		if (source === undefined) return undefined;
		const channel = await this.fetchChannel(options.chatId, options.threadId);
		if (channel === undefined || !channel.isTextBased() || !("send" in channel)) return undefined;
		const filename = options.attachment.filename ?? deriveFilenameFromSource(source, options.attachment.kind);
		try {
			const sendOpts: MessageCreateOptions = {
				files: [{ attachment: source, name: filename }],
			};
			if (options.attachment.caption !== undefined) sendOpts.content = options.attachment.caption;
			if (options.replyToMessageId !== undefined) {
				sendOpts.reply = { messageReference: options.replyToMessageId, failIfNotExists: false };
			}
			const message = await (channel as TextChannel | DMChannel).send(sendOpts);
			return { messageId: message.id, chunked: false };
		} catch (error) {
			throw normalizeApiError(error);
		}
	}

	private async syncSlashCommands(): Promise<void> {
		if (this.config.botToken === undefined || this.config.applicationId === undefined) return;
		const rest = new REST({ version: "10" }).setToken(this.config.botToken);
		const commands: Array<{ name: string; description: string }> = [
			{ name: "new", description: "Start a fresh session in this chat" },
			{ name: "reset", description: "Reset the conversation in this chat" },
			{ name: "stop", description: "Stop the current turn" },
			{ name: "forget_me", description: "Forget memories about you in this chat" },
			{ name: "privacy", description: "Show privacy and memory consent options" },
		];
		await rest.put(Routes.applicationCommands(this.config.applicationId), { body: commands });
	}

	private async handleMessage(message: Message): Promise<void> {
		if (message.author.bot) return;
		if (this.botId !== undefined && message.author.id === this.botId) return;
		const event = this.buildEvent(message);
		if (event === undefined) return;
		const guildId = message.guildId ?? undefined;
		const decision = this.allowList.check(event, guildId === undefined ? {} : { guildId });
		if (!decision.allowed) return;
		if (event.command !== undefined && SLASH_COMMANDS_INTERCEPTED.has(event.command)) {
			const handled = await this.handleSlashCommand(event);
			if (handled) return;
		}
		await this.dispatchMessage(event);
	}

	private async handleInteraction(interaction: Interaction): Promise<void> {
		if (!interaction.isChatInputCommand()) return;
		const command = interaction.commandName.toLowerCase();
		const chatId = interaction.channelId;
		const userId = interaction.user.id;
		if (SLASH_COMMANDS_INTERCEPTED.has(command)) {
			if (command === "new" || command === "reset") {
				await this.deps?.resetChatSession(chatId, undefined, userId);
				await interaction.reply({ content: "Session reset.", ephemeral: true }).catch(() => undefined);
				return;
			}
			if (command === "stop" || command === "abort") {
				await this.deps?.abortChatSession?.(chatId, undefined, userId);
				await interaction.reply({ content: "Stopping current turn.", ephemeral: true }).catch(() => undefined);
				return;
			}
			await interaction.reply({ content: `Command /${command} acknowledged.`, ephemeral: true }).catch(() => undefined);
		}
	}

	private buildEvent(message: Message): MessageEvent | undefined {
		const chatType = mapDiscordChatType(message);
		if (chatType === undefined) return undefined;
		const attachments = extractDiscordAttachments(message);
		const text = message.content ?? "";
		const event: MessageEvent = {
			platform: "discord",
			platformMessageId: message.id,
			chatId: message.channelId,
			chatType,
			userId: message.author.id,
			timestamp: message.createdTimestamp,
			text,
			type: discordMessageType(message, attachments),
			attachments,
			mentionsBot: this.detectMentionsBot(message),
			raw: message,
		};
		if (message.author.username !== undefined) event.userName = message.author.username;
		const displayName = message.member?.displayName ?? message.author.globalName ?? message.author.username;
		if (displayName !== null && displayName !== undefined) event.userDisplayName = displayName;
		if (message.reference?.messageId !== undefined && message.reference.messageId !== null) {
			event.replyToMessageId = message.reference.messageId;
		}
		if (message.hasThread && message.thread !== null) event.threadId = message.thread.id;
		const command = extractCommandName(text);
		if (command !== undefined) {
			event.command = command.name;
			event.commandArgs = command.args;
		}
		return event;
	}

	private detectMentionsBot(message: Message): boolean {
		if (message.channel.isDMBased()) return true;
		if (this.botId === undefined) return false;
		return message.mentions.users.has(this.botId);
	}

	private async handleSlashCommand(event: MessageEvent): Promise<boolean> {
		const cmd = event.command;
		if (cmd === undefined) return false;
		if (cmd === "new" || cmd === "reset") {
			await this.deps?.resetChatSession(event.chatId, event.threadId, event.userId);
			await this.replyToEvent(event, "Session reset. Send a message to start fresh.");
			return true;
		}
		if (cmd === "stop" || cmd === "abort") {
			await this.deps?.abortChatSession?.(event.chatId, event.threadId, event.userId);
			await this.replyToEvent(event, "Stopping the current turn.");
			return true;
		}
		return false;
	}

	private async replyToEvent(event: MessageEvent, text: string): Promise<void> {
		const opts: SendOptions = { chatId: event.chatId };
		if (event.threadId !== undefined) opts.threadId = event.threadId;
		if (event.platformMessageId !== "") opts.replyToMessageId = event.platformMessageId;
		await this.send(text, opts).catch(() => undefined);
	}

	private async waitForReady(): Promise<void> {
		if (this.ready) return;
		await new Promise<void>((resolve) => {
			this.client.once(Events.ClientReady, () => {
				this.ready = true;
				resolve();
			});
		});
	}

	private async fetchChannel(
		channelId: string,
		threadId?: string,
	): Promise<GuildTextBasedChannel | DMChannel | undefined> {
		const targetId: Snowflake = (threadId ?? channelId) as Snowflake;
		const cached = this.client.channels.cache.get(targetId);
		if (cached?.isTextBased()) return cached as GuildTextBasedChannel | DMChannel;
		try {
			const fetched = await this.client.channels.fetch(targetId);
			if (fetched === null || !fetched.isTextBased()) return undefined;
			return fetched as GuildTextBasedChannel | DMChannel;
		} catch {
			return undefined;
		}
	}

	private handleError(error: unknown): void {
		if (this.destroyed) return;
		const message = errorMessage(error);
		if (message.toLowerCase().includes("invalid token")) {
			this.setFatalError("discord_unauthorized", message, { retryable: false });
		}
	}
}

export interface DiscordFactoryOptions {
	deps: DiscordAdapterDeps;
	clientOptions?: ClientOptions;
}

export function createDiscordAdapterFactory(
	options: DiscordFactoryOptions,
): (config: DiscordPlatformConfig | unknown, stateDir: string) => DiscordAdapter {
	return (config: DiscordPlatformConfig | unknown, _stateDir: string): DiscordAdapter => {
		if (!isDiscordConfig(config)) {
			throw new Error("createDiscordAdapterFactory received a non-Discord config");
		}
		const adapterOptions: DiscordAdapterOptions = {
			config,
			deps: options.deps,
		};
		if (options.clientOptions !== undefined) adapterOptions.clientOptions = options.clientOptions;
		return new DiscordAdapter(adapterOptions);
	};
}

function isDiscordConfig(value: unknown): value is DiscordPlatformConfig {
	if (typeof value !== "object" || value === null) return false;
	const record = value as Record<string, unknown>;
	return (
		record.commandSyncPolicy === "auto" || record.commandSyncPolicy === "manual" || record.commandSyncPolicy === "off"
	);
}

function mapDiscordChatType(message: Message): ChatType | undefined {
	if (message.channel.isDMBased()) return "dm";
	if (message.channel.isThread()) return "thread";
	const guild = message.guildId;
	if (guild === null) return undefined;
	return "channel";
}

function discordMessageType(message: Message, attachments: MediaAttachment[]): MessageEvent["type"] {
	if (attachments.length > 0) {
		const first = attachments[0];
		if (first?.kind === "image") return "image";
		if (first?.kind === "video") return "video";
		if (first?.kind === "voice") return "voice";
		if (first?.kind === "document") return "document";
		if (first?.kind === "animation") return "animation";
	}
	if (message.stickers !== undefined && message.stickers.size > 0) return "sticker";
	return "text";
}

function extractDiscordAttachments(message: Message): MediaAttachment[] {
	const attachments: MediaAttachment[] = [];
	for (const attachment of message.attachments.values()) {
		const mime = attachment.contentType ?? undefined;
		const kind = inferAttachmentKind(mime, attachment.name);
		const att: MediaAttachment = { kind };
		att.url = attachment.url;
		att.fileId = attachment.id;
		if (mime !== undefined) att.mime = mime;
		if (attachment.name !== null && attachment.name !== undefined) att.filename = attachment.name;
		if (attachment.duration !== null && attachment.duration !== undefined) att.durationSec = attachment.duration;
		if (attachment.width !== null && attachment.width !== undefined) att.width = attachment.width;
		if (attachment.height !== null && attachment.height !== undefined) att.height = attachment.height;
		attachments.push(att);
	}
	for (const sticker of message.stickers.values()) {
		const att: MediaAttachment = { kind: "sticker", fileId: sticker.id };
		if (sticker.url !== undefined) att.url = sticker.url;
		attachments.push(att);
	}
	return attachments;
}

function inferAttachmentKind(mime: string | undefined, name: string | null): MediaAttachment["kind"] {
	const lower = (mime ?? "").toLowerCase();
	if (lower.startsWith("image/gif")) return "animation";
	if (lower.startsWith("image/")) return "image";
	if (lower.startsWith("video/")) return "video";
	if (lower.startsWith("audio/")) return "voice";
	if (name !== null) {
		const ext = name.split(".").pop()?.toLowerCase();
		if (ext === "gif") return "animation";
		if (ext === "png" || ext === "jpg" || ext === "jpeg" || ext === "webp") return "image";
		if (ext === "mp4" || ext === "mov" || ext === "webm") return "video";
		if (ext === "mp3" || ext === "ogg" || ext === "wav" || ext === "m4a") return "voice";
	}
	return "document";
}

function extractCommandName(text: string): { name: string; args: string } | undefined {
	if (!text.startsWith("/")) return undefined;
	const space = text.indexOf(" ");
	const head = space === -1 ? text : text.slice(0, space);
	const args = space === -1 ? "" : text.slice(space + 1).trim();
	const name = head.slice(1);
	if (name.length === 0) return undefined;
	if (!/^[a-z0-9_]+$/i.test(name)) return undefined;
	return { name: name.toLowerCase(), args };
}

function truncateForDiscord(text: string): string {
	if (text.length <= DISCORD_MAX_LENGTH) return text;
	return text.slice(0, DISCORD_MAX_LENGTH);
}

function deriveFilenameFromSource(source: string, kind: MediaAttachment["kind"]): string {
	const fromUrl = source.split("/").pop()?.split("?")[0];
	if (fromUrl !== undefined && fromUrl.length > 0) return fromUrl;
	if (kind === "image") return "image.png";
	if (kind === "video") return "video.mp4";
	if (kind === "voice") return "voice.ogg";
	if (kind === "animation") return "animation.gif";
	return "file.bin";
}

function errorMessage(error: unknown): string {
	if (error instanceof Error) return error.message;
	return String(error);
}

interface FloodControlMarker extends Error {
	retryAfterMs?: number;
}

function normalizeApiError(error: unknown): Error {
	if (error instanceof Error) {
		const message = error.message.toLowerCase();
		if (message.includes("rate limit") || message.includes("429")) {
			const match = error.message.match(/retry after\s+(\d+(?:\.\d+)?)/i);
			const retryAfterMs = match ? Math.round(Number(match[1]) * 1000) : undefined;
			const wrapped: FloodControlMarker = new Error(`discord flood: ${error.message}`);
			if (retryAfterMs !== undefined) wrapped.retryAfterMs = retryAfterMs;
			return wrapped;
		}
		return error;
	}
	return new Error(String(error));
}
