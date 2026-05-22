export type Platform = "telegram" | "discord";

export type MessageType = "text" | "voice" | "image" | "video" | "document" | "sticker" | "animation" | "location";

export type ChatType = "dm" | "group" | "channel" | "supergroup" | "thread";

export type ProcessingOutcome =
	| { type: "ok" }
	| { type: "rejected"; reason: string }
	| { type: "aborted" }
	| { type: "error"; error: string };

export interface MediaAttachment {
	kind: "image" | "video" | "document" | "voice" | "audio" | "animation" | "sticker";
	url?: string;
	localPath?: string;
	mime?: string;
	caption?: string;
	filename?: string;
	durationSec?: number;
	width?: number;
	height?: number;
	stickerEmoji?: string;
	fileId?: string;
}

export interface MessageEvent {
	platform: Platform;
	platformMessageId: string;
	chatId: string;
	chatType: ChatType;
	userId: string;
	userDisplayName?: string;
	userName?: string;
	threadId?: string;
	timestamp: number;
	text: string;
	type: MessageType;
	attachments: MediaAttachment[];
	replyToMessageId?: string;
	mentionsBot: boolean;
	command?: string;
	commandArgs?: string;
	raw?: unknown;
}

export interface SendResult {
	messageId: string;
	chunked: boolean;
	chunkIndex?: number;
	totalChunks?: number;
}

export interface SendOptions {
	chatId: string;
	threadId?: string;
	replyToMessageId?: string;
	disableNotification?: boolean;
	parseMode?: "markdown" | "html" | "none";
	ephemeralTtlSeconds?: number;
	captionMedia?: MediaAttachment[];
}

export interface EditOptions extends SendOptions {
	messageId: string;
}

export interface SendMediaOptions extends SendOptions {
	attachment: MediaAttachment;
}

export class EphemeralReply {
	readonly text: string;
	readonly ttlSeconds: number | undefined;

	constructor(text: string, ttlSeconds?: number) {
		this.text = text;
		this.ttlSeconds = ttlSeconds;
	}
}

export interface PlatformCapabilities {
	maxMessageLength: number;
	supportsEditing: boolean;
	supportsDeletion: boolean;
	supportsTyping: boolean;
	supportsImages: boolean;
	supportsVoice: boolean;
	supportsDocuments: boolean;
	supportsAnimations: boolean;
	supportsReactions: boolean;
	supportsThreads: boolean;
	supportsForums: boolean;
	supportsSlashCommandSync: boolean;
	editRateLimitMs: number;
}

export interface FatalErrorState {
	code: string;
	message: string;
	retryable: boolean;
	at: number;
}
