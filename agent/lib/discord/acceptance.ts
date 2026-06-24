/**
 * Free-will acceptance gate for Clanky's Discord presence (SPEC.md §5.2).
 *
 * Stage one of two: a cheap, credential-free decision about whether an inbound
 * message is worth a model turn at all. Stage two is the model itself, which may
 * answer or emit [SKIP] (see isSkipReplyText).
 */
import { DEFAULT_DISCORD_WAKE_NAMES, resolveWakeNameMatch } from "./wake-names.ts";

export type DiscordConversationKind = "dm" | "channel" | "group" | "thread" | "custom";

/** Normalized inbound Discord message the gateway hands to the acceptance gate. */
export interface DiscordInboundMessage {
	externalMessageId: string;
	/** Conversation id (channel id, or thread id for a thread message). */
	channelId: string;
	threadId?: string;
	parentId?: string;
	guildId?: string;
	authorId: string;
	authorName?: string;
	authorIsBot?: boolean;
	text: string;
	kind: DiscordConversationKind;
	/** Discord platform @mention of the bot user. */
	mentionsSelf: boolean;
	replyToExternalMessageId?: string;
	attachments?: DiscordInboundAttachment[];
	embeds?: DiscordInboundEmbed[];
}

export interface DiscordInboundAttachment {
	id: string;
	url: string;
	filename?: string;
	contentType?: string;
	size?: number;
	width?: number;
	height?: number;
	description?: string;
}

export interface DiscordInboundEmbed {
	type?: string;
	url?: string;
	title?: string;
	description?: string;
	provider?: string;
	imageUrl?: string;
	thumbnailUrl?: string;
	videoUrl?: string;
}

export type DiscordAcceptanceReason =
	| "bound_conversation"
	| "dm"
	| "platform_mention"
	| "reply_to_self"
	| "name_address"
	| "name_mention"
	| "recent_engagement";

export type DiscordIgnoreReason = "not_engaged_no_mention" | "self_message" | "ignored_bot";

export type DiscordAcceptanceDecision =
	| { accepted: true; reason: DiscordAcceptanceReason; recordInboundEngagement: boolean }
	| { accepted: false; reason: DiscordIgnoreReason };

export interface DiscordAcceptanceOptions {
	/** Wake names to match; defaults to the built-in set. */
	wakeNames?: readonly string[];
	/** True if the channel/user is inside an active engagement window. */
	isEngaged: (channelId: string, userId: string) => boolean;
	/** True if the given message id is one Clanky recently sent (reply-to-self). */
	isKnownSelfMessage: (messageId: string) => boolean;
	/** The bot's own user id, so its own messages never trigger a turn. */
	selfUserId?: string;
	/** When set, this profile only listens to one conversation. */
	boundConversationId?: string;
	/** Whether to ignore messages authored by other bots (default true). */
	ignoreBotMessages?: boolean;
}

/**
 * Decide whether an inbound Discord message earns a model turn. Acceptance only
 * means "think about it" — the model still decides whether to actually reply.
 */
export function decideDiscordInbound(
	message: DiscordInboundMessage,
	options: DiscordAcceptanceOptions,
): DiscordAcceptanceDecision {
	if (options.selfUserId !== undefined && message.authorId === options.selfUserId) {
		return { accepted: false, reason: "self_message" };
	}
	if ((options.ignoreBotMessages ?? true) && message.authorIsBot === true) {
		return { accepted: false, reason: "ignored_bot" };
	}

	if (options.boundConversationId !== undefined) {
		const matched =
			message.channelId === options.boundConversationId ||
			message.threadId === options.boundConversationId ||
			message.parentId === options.boundConversationId;
		return matched
			? { accepted: true, reason: "bound_conversation", recordInboundEngagement: true }
			: { accepted: false, reason: "not_engaged_no_mention" };
	}

	if (message.kind === "dm") return { accepted: true, reason: "dm", recordInboundEngagement: true };
	if (message.mentionsSelf) return { accepted: true, reason: "platform_mention", recordInboundEngagement: true };
	if (message.replyToExternalMessageId !== undefined && options.isKnownSelfMessage(message.replyToExternalMessageId)) {
		return { accepted: true, reason: "reply_to_self", recordInboundEngagement: true };
	}

	const wakeMatch = resolveWakeNameMatch(message.text, options.wakeNames ?? DEFAULT_DISCORD_WAKE_NAMES);
	if (wakeMatch.addressed) return { accepted: true, reason: "name_address", recordInboundEngagement: true };
	if (wakeMatch.mentioned) return { accepted: true, reason: "name_mention", recordInboundEngagement: true };

	// Engagement window: after a real engagement in this channel/thread, listen to
	// short follow-ups without requiring another mention. A follow-up only extends
	// the window again if Clanky actually replies (recordInboundEngagement=false).
	if (options.isEngaged(message.channelId, message.authorId)) {
		return { accepted: true, reason: "recent_engagement", recordInboundEngagement: false };
	}

	return { accepted: false, reason: "not_engaged_no_mention" };
}

/** The model's opt-out: an accepted turn that decides to stay silent. */
export function isSkipReplyText(text: string): boolean {
	return /^\[SKIP\]$/i.test(text.trim());
}

export const DEFAULT_ENGAGEMENT_WINDOW_MS = 5 * 60 * 1000;

export function resolveEngagementWindowMs(env: NodeJS.ProcessEnv): number {
	const raw = env.CLANKY_DISCORD_ENGAGEMENT_WINDOW_MINUTES?.trim();
	if (raw === undefined || raw.length === 0) return DEFAULT_ENGAGEMENT_WINDOW_MS;
	const minutes = Number.parseFloat(raw);
	if (!Number.isFinite(minutes) || minutes < 0) return DEFAULT_ENGAGEMENT_WINDOW_MS;
	return Math.floor(minutes * 60 * 1000);
}

/**
 * Tracks recent engagement per channel+user so short follow-ups land without a
 * re-mention. The clock is injectable to keep the logic pure and testable.
 */
export class EngagementTracker {
	private readonly lastEngagedAt = new Map<string, number>();
	private readonly windowMs: number;
	private readonly now: () => number;

	constructor(windowMs: number = DEFAULT_ENGAGEMENT_WINDOW_MS, now: () => number = Date.now) {
		this.windowMs = windowMs;
		this.now = now;
	}

	private key(channelId: string, userId: string): string {
		return `${channelId}\u0000${userId}`;
	}

	record(channelId: string, userId: string): void {
		this.lastEngagedAt.set(this.key(channelId, userId), this.now());
	}

	isEngaged(channelId: string, userId: string): boolean {
		const at = this.lastEngagedAt.get(this.key(channelId, userId));
		if (at === undefined) return false;
		if (this.now() - at > this.windowMs) {
			this.lastEngagedAt.delete(this.key(channelId, userId));
			return false;
		}
		return true;
	}

	clear(channelId: string, userId: string): void {
		this.lastEngagedAt.delete(this.key(channelId, userId));
	}
}
