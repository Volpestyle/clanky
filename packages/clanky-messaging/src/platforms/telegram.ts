import { Bot, type Context, GrammyError, HttpError } from "grammy";
import type { Message, Update } from "grammy/types";
import { BasePlatformAdapter } from "../adapter.ts";
import { AllowList } from "../allowlist.ts";
import type { TelegramPlatformConfig } from "../config.ts";
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
import {
	applyParseMode,
	splitForTelegram,
	type TelegramParseMode,
	telegramParseModeOption,
} from "./telegram-format.ts";
import { transcribeTelegramVoice } from "./telegram-transcribe.ts";

const TELEGRAM_MAX_LENGTH = 4096;
const RECONNECT_INITIAL_DELAY_MS = 1_000;
const RECONNECT_MAX_DELAY_MS = 60_000;
const CONFLICT_BACKOFF_MS = 5_000;

const SLASH_COMMANDS_INTERCEPTED = new Set([
	"start",
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

export interface TelegramAdapterDeps {
	resetChatSession: (chatId: string, threadId?: string, userId?: string) => Promise<void>;
	abortChatSession?: (chatId: string, threadId?: string, userId?: string) => Promise<void>;
}

export interface TelegramAdapterOptions {
	config: TelegramPlatformConfig;
	deps?: TelegramAdapterDeps;
	now?: () => number;
	apiRoot?: string;
}

export interface TelegramFactoryOptions {
	deps: TelegramAdapterDeps;
	apiRoot?: string;
}

export function createTelegramAdapterFactory(
	options: TelegramFactoryOptions,
): (config: TelegramPlatformConfig | unknown, stateDir: string) => TelegramAdapter {
	return (config: TelegramPlatformConfig | unknown, _stateDir: string): TelegramAdapter => {
		if (!isTelegramConfig(config)) {
			throw new Error("createTelegramAdapterFactory received a non-Telegram config");
		}
		const adapterOptions: TelegramAdapterOptions = {
			config,
			deps: options.deps,
		};
		if (options.apiRoot !== undefined) adapterOptions.apiRoot = options.apiRoot;
		return new TelegramAdapter(adapterOptions);
	};
}

function isTelegramConfig(value: unknown): value is TelegramPlatformConfig {
	if (typeof value !== "object" || value === null) return false;
	const record = value as Record<string, unknown>;
	return record.pollingMode === "long_poll" || record.pollingMode === "webhook" || record.pollingMode === "disabled";
}

export class TelegramAdapter extends BasePlatformAdapter {
	readonly platform: Platform = "telegram";
	readonly capabilities: PlatformCapabilities;

	private readonly bot: Bot;
	private readonly config: TelegramPlatformConfig;
	private readonly allowList: AllowList;
	private readonly deps: TelegramAdapterDeps | undefined;
	private readonly mentionPatterns: RegExp[];
	private botUsername: string | undefined;
	private botId: number | undefined;
	private stopRequested = false;
	private reconnectAttempts = 0;
	private pollingDriver: Promise<void> | undefined;

	constructor(options: TelegramAdapterOptions) {
		super();
		this.config = options.config;
		this.deps = options.deps;
		this.allowList = new AllowList(options.config.allowList);
		this.mentionPatterns = compileMentionPatterns(options.config.mentionPatterns);
		this.capabilities = {
			maxMessageLength: Math.min(options.config.maxMessageLength, TELEGRAM_MAX_LENGTH),
			supportsEditing: true,
			supportsDeletion: true,
			supportsTyping: true,
			supportsImages: true,
			supportsVoice: true,
			supportsDocuments: true,
			supportsAnimations: true,
			supportsReactions: true,
			supportsThreads: true,
			supportsForums: true,
			supportsSlashCommandSync: false,
			editRateLimitMs: options.config.editRateLimitMs,
		};
		if (options.config.botToken === undefined) {
			throw new Error("TelegramAdapter requires a botToken in config");
		}
		const apiRoot = options.apiRoot ?? options.config.apiRoot;
		const botOptions = apiRoot === undefined ? undefined : { client: { apiRoot } };
		this.bot = new Bot(options.config.botToken, botOptions);
		this.bot.on("message", (ctx) => this.handleUpdate(ctx).catch((error: unknown) => this.handleError(error)));
		this.bot.on("edited_message", (ctx) =>
			this.handleUpdate(ctx, { edited: true }).catch((error: unknown) => this.handleError(error)),
		);
		this.bot.catch((error) => this.handleError(error.error));
	}

	async connect(): Promise<boolean> {
		if (this.config.pollingMode === "disabled") {
			this.markConnected();
			return true;
		}
		try {
			const me = await this.bot.api.getMe();
			this.botUsername = me.username;
			this.botId = me.id;
		} catch (error) {
			this.setFatalError("telegram_getme_failed", errorMessage(error), { retryable: true });
			return false;
		}
		this.stopRequested = false;
		this.pollingDriver = this.runPollingLoop();
		this.markConnected();
		return true;
	}

	async disconnect(): Promise<void> {
		this.stopRequested = true;
		try {
			await this.bot.stop();
		} catch {
			// ignore
		}
		this.markDisconnected();
		if (this.pollingDriver !== undefined) {
			await this.pollingDriver.catch(() => undefined);
			this.pollingDriver = undefined;
		}
	}

	async send(text: string, options: SendOptions): Promise<SendResult> {
		const parseMode: TelegramParseMode =
			options.parseMode === undefined ? this.config.parseMode : mapParseMode(options.parseMode);
		const chunks = splitForTelegram(text, this.capabilities.maxMessageLength);
		const first = chunks[0] ?? text;
		const rendered = applyParseMode(first, parseMode);
		const opts: Record<string, unknown> = {
			link_preview_options: { is_disabled: true },
		};
		const parseModeOpt = telegramParseModeOption(parseMode);
		if (parseModeOpt !== undefined) opts.parse_mode = parseModeOpt;
		if (options.threadId !== undefined) opts.message_thread_id = numberOrUndefined(options.threadId);
		if (options.replyToMessageId !== undefined) {
			opts.reply_parameters = { message_id: numberOrUndefined(options.replyToMessageId) };
		}
		const chatId = numberOrString(options.chatId);
		try {
			const message = await this.bot.api.sendMessage(
				chatId,
				rendered,
				opts as Parameters<typeof this.bot.api.sendMessage>[2],
			);
			return { messageId: String(message.message_id), chunked: chunks.length > 1 };
		} catch (error) {
			throw normalizeApiError(error);
		}
	}

	async editMessage(text: string, options: EditOptions): Promise<SendResult> {
		const parseMode: TelegramParseMode =
			options.parseMode === undefined ? this.config.parseMode : mapParseMode(options.parseMode);
		const rendered = applyParseMode(text, parseMode);
		const opts: Record<string, unknown> = { link_preview_options: { is_disabled: true } };
		const parseModeOpt = telegramParseModeOption(parseMode);
		if (parseModeOpt !== undefined) opts.parse_mode = parseModeOpt;
		try {
			await this.bot.api.editMessageText(
				numberOrString(options.chatId),
				numberOrUndefined(options.messageId) ?? 0,
				rendered,
				opts as Parameters<typeof this.bot.api.editMessageText>[3],
			);
			return { messageId: options.messageId, chunked: false };
		} catch (error) {
			throw normalizeApiError(error);
		}
	}

	async deleteMessage(chatId: string, messageId: string): Promise<boolean> {
		try {
			await this.bot.api.deleteMessage(numberOrString(chatId), numberOrUndefined(messageId) ?? 0);
			return true;
		} catch {
			return false;
		}
	}

	override async sendTyping(chatId: string, threadId?: string): Promise<void> {
		const opts: Record<string, unknown> = {};
		if (threadId !== undefined) opts.message_thread_id = numberOrUndefined(threadId);
		try {
			await this.bot.api.sendChatAction(
				numberOrString(chatId),
				"typing",
				opts as Parameters<typeof this.bot.api.sendChatAction>[2],
			);
		} catch {
			// non-fatal
		}
	}

	override async sendImage(options: SendMediaOptions): Promise<SendResult | undefined> {
		return await this.sendMedia(options, "photo");
	}

	override async sendVideo(options: SendMediaOptions): Promise<SendResult | undefined> {
		return await this.sendMedia(options, "video");
	}

	override async sendDocument(options: SendMediaOptions): Promise<SendResult | undefined> {
		return await this.sendMedia(options, "document");
	}

	override async sendVoice(options: SendMediaOptions): Promise<SendResult | undefined> {
		return await this.sendMedia(options, "voice");
	}

	override async sendAnimation(options: SendMediaOptions): Promise<SendResult | undefined> {
		return await this.sendMedia(options, "animation");
	}

	override formatMessage(text: string): string {
		return text;
	}

	override splitForOverflow(text: string): string[] {
		return splitForTelegram(text, this.capabilities.maxMessageLength);
	}

	private async sendMedia(
		options: SendMediaOptions,
		kind: "photo" | "video" | "document" | "voice" | "animation",
	): Promise<SendResult | undefined> {
		const source = options.attachment.url ?? options.attachment.localPath;
		if (source === undefined) return undefined;
		const chatId = numberOrString(options.chatId);
		const captionParseMode: TelegramParseMode =
			options.parseMode === undefined ? this.config.parseMode : mapParseMode(options.parseMode);
		const caption =
			options.attachment.caption === undefined
				? undefined
				: applyParseMode(options.attachment.caption, captionParseMode);
		const captionParseModeOpt = telegramParseModeOption(captionParseMode);
		const opts: Record<string, unknown> = {};
		if (caption !== undefined) opts.caption = caption;
		if (captionParseModeOpt !== undefined) opts.parse_mode = captionParseModeOpt;
		if (options.threadId !== undefined) opts.message_thread_id = numberOrUndefined(options.threadId);
		if (options.replyToMessageId !== undefined) {
			opts.reply_parameters = { message_id: numberOrUndefined(options.replyToMessageId) };
		}
		try {
			let message: Message;
			if (kind === "photo") {
				message = await this.bot.api.sendPhoto(chatId, source, opts as Parameters<typeof this.bot.api.sendPhoto>[2]);
			} else if (kind === "video") {
				message = await this.bot.api.sendVideo(chatId, source, opts as Parameters<typeof this.bot.api.sendVideo>[2]);
			} else if (kind === "document") {
				message = await this.bot.api.sendDocument(
					chatId,
					source,
					opts as Parameters<typeof this.bot.api.sendDocument>[2],
				);
			} else if (kind === "voice") {
				message = await this.bot.api.sendVoice(chatId, source, opts as Parameters<typeof this.bot.api.sendVoice>[2]);
			} else {
				message = await this.bot.api.sendAnimation(
					chatId,
					source,
					opts as Parameters<typeof this.bot.api.sendAnimation>[2],
				);
			}
			return { messageId: String(message.message_id), chunked: false };
		} catch (error) {
			throw normalizeApiError(error);
		}
	}

	private async runPollingLoop(): Promise<void> {
		while (!this.stopRequested) {
			try {
				await this.bot.start({
					drop_pending_updates: false,
					onStart: () => {
						this.reconnectAttempts = 0;
					},
				});
				return;
			} catch (error) {
				if (this.stopRequested) return;
				const delayMs = this.computeReconnectDelay(error);
				this.reconnectAttempts += 1;
				if (this.reconnectAttempts >= 10) {
					this.setFatalError("telegram_polling_failed", errorMessage(error), { retryable: true });
				}
				await sleep(delayMs);
			}
		}
	}

	private computeReconnectDelay(error: unknown): number {
		if (isConflictError(error)) return CONFLICT_BACKOFF_MS;
		const base = Math.min(RECONNECT_INITIAL_DELAY_MS * 2 ** this.reconnectAttempts, RECONNECT_MAX_DELAY_MS);
		return base;
	}

	private handleError(error: unknown): void {
		if (this.stopRequested) return;
		if (error instanceof GrammyError && error.error_code === 401) {
			this.setFatalError("telegram_unauthorized", error.description, { retryable: false });
		}
	}

	private async handleUpdate(ctx: Context, options: { edited?: boolean } = {}): Promise<void> {
		const message = options.edited === true ? ctx.editedMessage : ctx.message;
		if (message === undefined) return;
		const event = this.buildEvent(message, ctx.update);
		if (event === undefined) return;

		const guildId = chatGuildId(message);
		const decision = this.allowList.check(event, guildId === undefined ? {} : { guildId });
		if (!decision.allowed) return;

		if (event.command !== undefined && SLASH_COMMANDS_INTERCEPTED.has(event.command)) {
			const handled = await this.handleSlashCommand(event);
			if (handled) return;
		}

		const enrichedText = await this.transcribeIfVoice(event);
		if (enrichedText !== undefined && enrichedText.length > 0) event.text = enrichedText;
		await this.dispatchMessage(event);
	}

	private buildEvent(message: Message, update: Update): MessageEvent | undefined {
		const chatType = mapChatType(message);
		if (chatType === undefined) return undefined;
		const text = messageText(message);
		const attachments = extractAttachments(message);
		const ignoredThreads = new Set(this.config.ignoredThreads);
		if (message.message_thread_id !== undefined && ignoredThreads.has(message.message_thread_id)) return undefined;
		const userId = String(message.from?.id ?? "anonymous");
		const event: MessageEvent = {
			platform: "telegram",
			platformMessageId: String(message.message_id),
			chatId: String(message.chat.id),
			chatType,
			userId,
			timestamp: (message.date ?? Math.floor(Date.now() / 1000)) * 1000,
			text: text ?? "",
			type: messageType(message, attachments),
			attachments,
			mentionsBot: this.detectMentionsBot(message, text),
			raw: update,
		};
		if (message.from?.username !== undefined) event.userName = message.from.username;
		const displayName = telegramDisplayName(message);
		if (displayName !== undefined) event.userDisplayName = displayName;
		if (message.message_thread_id !== undefined) event.threadId = String(message.message_thread_id);
		if (message.reply_to_message?.message_id !== undefined) {
			event.replyToMessageId = String(message.reply_to_message.message_id);
		}
		const command = extractCommandName(message);
		if (command !== undefined) {
			event.command = command.name;
			event.commandArgs = command.args;
		}
		return event;
	}

	private detectMentionsBot(message: Message, text: string | undefined): boolean {
		if (message.chat.type === "private") return true;
		if (text === undefined || text.length === 0) return false;
		const username = this.botUsername;
		if (username !== undefined && text.toLowerCase().includes(`@${username.toLowerCase()}`)) return true;
		if (this.botId !== undefined && message.entities !== undefined) {
			for (const entity of message.entities) {
				if (entity.type === "mention" || entity.type === "text_mention") return true;
			}
		}
		for (const pattern of this.mentionPatterns) {
			if (pattern.test(text)) return true;
		}
		return false;
	}

	private async handleSlashCommand(event: MessageEvent): Promise<boolean> {
		const cmd = event.command;
		if (cmd === undefined) return false;
		if (cmd === "start" || cmd === "new" || cmd === "reset") {
			await this.deps?.resetChatSession(event.chatId, event.threadId, event.userId);
			await this.replyToEvent(event, "Session reset. Send a message to start fresh.");
			return true;
		}
		if (cmd === "stop" || cmd === "abort") {
			await this.deps?.abortChatSession?.(event.chatId, event.threadId, event.userId);
			await this.replyToEvent(event, "Stopping the current turn. Send a new message to continue.");
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

	private async transcribeIfVoice(event: MessageEvent): Promise<string | undefined> {
		if (event.type !== "voice") return undefined;
		const voiceAttachment = event.attachments.find((attachment) => attachment.kind === "voice");
		if (voiceAttachment?.fileId === undefined) return undefined;
		const mime = voiceAttachment.mime ?? "audio/ogg";
		try {
			return await this.transcribeVoiceMessage(voiceAttachment.fileId, mime);
		} catch {
			return undefined;
		}
	}

	override extractIncomingMedia(raw: unknown): MediaAttachment[] {
		if (typeof raw !== "object" || raw === null) return [];
		const update = raw as Update;
		const message = update.message ?? update.edited_message;
		if (message === undefined) return [];
		return extractAttachments(message);
	}

	async downloadFile(fileId: string): Promise<Buffer | undefined> {
		try {
			const file = await this.bot.api.getFile(fileId);
			if (file.file_path === undefined) return undefined;
			const url = this.fileDownloadUrl(file.file_path);
			const response = await fetch(url);
			if (!response.ok) return undefined;
			const arrayBuffer = await response.arrayBuffer();
			return Buffer.from(arrayBuffer);
		} catch {
			return undefined;
		}
	}

	async transcribeVoiceMessage(fileId: string, mime: string): Promise<string> {
		const data = await this.downloadFile(fileId);
		if (data === undefined) return "[voice message: download failed]";
		return await transcribeTelegramVoice(this.getAdapterContext(), { mime, data });
	}

	private fileDownloadUrl(filePath: string): string {
		const root = this.config.apiRoot ?? "https://api.telegram.org";
		const trimmed = root.replace(/\/+$/, "");
		const token = this.config.botToken ?? "";
		return `${trimmed}/file/bot${token}/${filePath}`;
	}
}

function compileMentionPatterns(patterns: readonly string[]): RegExp[] {
	const compiled: RegExp[] = [];
	for (const pattern of patterns) {
		try {
			compiled.push(new RegExp(pattern, "i"));
		} catch {
			// ignore invalid patterns
		}
	}
	return compiled;
}

function mapChatType(message: Message): ChatType | undefined {
	const type = message.chat.type;
	if (type === "private") return "dm";
	if (type === "group") return "group";
	if (type === "supergroup") return message.message_thread_id !== undefined ? "thread" : "supergroup";
	if (type === "channel") return "channel";
	return undefined;
}

function chatGuildId(message: Message): string | undefined {
	if (message.chat.type === "supergroup" || message.chat.type === "channel" || message.chat.type === "group") {
		return String(message.chat.id);
	}
	return undefined;
}

function messageText(message: Message): string | undefined {
	if (message.text !== undefined) return message.text;
	if (message.caption !== undefined) return message.caption;
	return undefined;
}

function messageType(message: Message, attachments: MediaAttachment[]): MessageEvent["type"] {
	if (message.voice !== undefined) return "voice";
	if (message.photo !== undefined) return "image";
	if (message.video !== undefined || message.video_note !== undefined) return "video";
	if (message.animation !== undefined) return "animation";
	if (message.document !== undefined) return "document";
	if (message.sticker !== undefined) return "sticker";
	if (attachments.length > 0) {
		const first = attachments[0];
		if (first?.kind === "image") return "image";
		if (first?.kind === "video") return "video";
		if (first?.kind === "voice") return "voice";
		if (first?.kind === "document") return "document";
		if (first?.kind === "sticker") return "sticker";
	}
	return "text";
}

function extractAttachments(message: Message): MediaAttachment[] {
	const attachments: MediaAttachment[] = [];
	if (message.photo !== undefined && message.photo.length > 0) {
		const largest = message.photo.reduce((best, current) =>
			(current.file_size ?? 0) > (best.file_size ?? 0) ? current : best,
		);
		const att: MediaAttachment = { kind: "image", fileId: largest.file_id };
		if (largest.width !== undefined) att.width = largest.width;
		if (largest.height !== undefined) att.height = largest.height;
		attachments.push(att);
	}
	if (message.video !== undefined) {
		const att: MediaAttachment = { kind: "video", fileId: message.video.file_id };
		if (message.video.mime_type !== undefined) att.mime = message.video.mime_type;
		if (message.video.duration !== undefined) att.durationSec = message.video.duration;
		if (message.video.width !== undefined) att.width = message.video.width;
		if (message.video.height !== undefined) att.height = message.video.height;
		attachments.push(att);
	}
	if (message.voice !== undefined) {
		const att: MediaAttachment = { kind: "voice", fileId: message.voice.file_id };
		if (message.voice.mime_type !== undefined) att.mime = message.voice.mime_type;
		if (message.voice.duration !== undefined) att.durationSec = message.voice.duration;
		attachments.push(att);
	}
	if (message.document !== undefined) {
		const att: MediaAttachment = { kind: "document", fileId: message.document.file_id };
		if (message.document.mime_type !== undefined) att.mime = message.document.mime_type;
		if (message.document.file_name !== undefined) att.filename = message.document.file_name;
		attachments.push(att);
	}
	if (message.animation !== undefined) {
		const att: MediaAttachment = { kind: "animation", fileId: message.animation.file_id };
		if (message.animation.mime_type !== undefined) att.mime = message.animation.mime_type;
		attachments.push(att);
	}
	if (message.sticker !== undefined) {
		const att: MediaAttachment = { kind: "sticker", fileId: message.sticker.file_id };
		if (message.sticker.emoji !== undefined) att.stickerEmoji = message.sticker.emoji;
		attachments.push(att);
	}
	return attachments;
}

function telegramDisplayName(message: Message): string | undefined {
	const from = message.from;
	if (from === undefined) return undefined;
	if (from.first_name !== undefined && from.last_name !== undefined) return `${from.first_name} ${from.last_name}`;
	if (from.first_name !== undefined) return from.first_name;
	return undefined;
}

function extractCommandName(message: Message): { name: string; args: string } | undefined {
	const text = message.text;
	if (text === undefined || !text.startsWith("/")) return undefined;
	const entity = message.entities?.find((entry) => entry.type === "bot_command" && entry.offset === 0);
	if (entity === undefined) return undefined;
	const raw = text.slice(0, entity.length);
	const args = text.slice(entity.length).trim();
	const nameWithAt = raw.startsWith("/") ? raw.slice(1) : raw;
	const atIndex = nameWithAt.indexOf("@");
	const name = atIndex === -1 ? nameWithAt : nameWithAt.slice(0, atIndex);
	return { name, args };
}

function mapParseMode(mode: "markdown" | "html" | "none"): TelegramParseMode {
	if (mode === "markdown") return "MarkdownV2";
	if (mode === "html") return "HTML";
	return "none";
}

function numberOrString(value: string): number | string {
	const parsed = Number(value);
	return Number.isInteger(parsed) ? parsed : value;
}

function numberOrUndefined(value: string): number | undefined {
	const parsed = Number(value);
	return Number.isFinite(parsed) && Number.isInteger(parsed) ? parsed : undefined;
}

function isConflictError(error: unknown): boolean {
	if (error instanceof GrammyError) return error.error_code === 409;
	if (error instanceof HttpError) return false;
	return false;
}

function errorMessage(error: unknown): string {
	if (error instanceof Error) return error.message;
	return String(error);
}

interface FloodControlMarker extends Error {
	retryAfterMs?: number;
}

function normalizeApiError(error: unknown): Error {
	if (error instanceof GrammyError) {
		if (error.error_code === 429) {
			const retryAfterRaw = error.parameters?.retry_after;
			const retryAfterMs = typeof retryAfterRaw === "number" ? retryAfterRaw * 1000 : undefined;
			const wrapped: FloodControlMarker = new Error(`flood control: ${error.description}`);
			if (retryAfterMs !== undefined) wrapped.retryAfterMs = retryAfterMs;
			return wrapped;
		}
		return new Error(`telegram api ${error.error_code}: ${error.description}`);
	}
	if (error instanceof HttpError) return new Error(`telegram http: ${error.message}`);
	if (error instanceof Error) return error;
	return new Error(String(error));
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
