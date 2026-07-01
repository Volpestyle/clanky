/**
 * Free-will acceptance gate for Clanky's Discord presence (SPEC.md §5.2).
 *
 * Stage one of two: a cheap, credential-free decision about whether an inbound
 * message is worth a model turn at all. Stage two is the model itself, which may
 * answer or emit [SKIP] (see isSkipReplyText).
 */
import { TtlCache } from "../ttl-cache.ts";
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

export type DiscordScopeIgnoreReason = "blocked_dm" | "blocked_guild" | "blocked_channel";

export type DiscordIgnoreReason =
	| "not_engaged_no_mention"
	| "self_message"
	| "ignored_bot"
	| DiscordScopeIgnoreReason;

export type DiscordAcceptanceDecision =
	| { accepted: true; reason: DiscordAcceptanceReason; recordInboundEngagement: boolean }
	| { accepted: false; reason: DiscordIgnoreReason };

export interface DiscordAcceptanceOptions {
	/** Wake names to match; defaults to the built-in set. */
	wakeNames?: readonly string[];
	/** If set, guild messages outside these server ids are ignored before wake matching. */
	allowedGuildIds?: readonly string[];
	/** If set, messages outside these channel/thread/parent channel ids are ignored before wake matching. */
	allowedChannelIds?: readonly string[];
	/** Whether DMs are eligible. Defaults to true. */
	allowDms?: boolean;
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

export interface DiscordScopeOptions {
	allowedGuildIds?: readonly string[];
	allowedChannelIds?: readonly string[];
	allowDms?: boolean;
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
	const scopeReason = decideDiscordScope(message, options);
	if (scopeReason !== undefined) return { accepted: false, reason: scopeReason };

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

export function decideDiscordScope(
	message: DiscordInboundMessage,
	options: DiscordScopeOptions,
): DiscordScopeIgnoreReason | undefined {
	if (message.kind === "dm") return options.allowDms === false ? "blocked_dm" : undefined;

	const allowedGuildIds = normalizedIdSet(options.allowedGuildIds);
	if (allowedGuildIds !== undefined) {
		if (message.guildId === undefined || !allowedGuildIds.has(message.guildId)) return "blocked_guild";
	}

	const allowedChannelIds = normalizedIdSet(options.allowedChannelIds);
	if (allowedChannelIds !== undefined) {
		const ids = [message.channelId, message.threadId, message.parentId].filter((id): id is string => id !== undefined);
		if (!ids.some((id) => allowedChannelIds.has(id))) return "blocked_channel";
	}

	return undefined;
}

function normalizedIdSet(ids: readonly string[] | undefined): Set<string> | undefined {
	const set = new Set((ids ?? []).map((id) => id.trim()).filter((id) => id.length > 0));
	return set.size === 0 ? undefined : set;
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

export function parseDiscordIdAllowlist(raw: string | undefined): string[] {
	return [...new Set((raw ?? "").split(/[\s,]+/).map((id) => id.trim()).filter((id) => id.length > 0))];
}

export function resolveDiscordAllowDms(env: NodeJS.ProcessEnv): boolean {
	const raw = env.CLANKY_DISCORD_ALLOW_DMS?.trim().toLowerCase();
	if (raw === undefined || raw.length === 0) return true;
	return !["0", "false", "no", "off"].includes(raw);
}

export function resolveDiscordScopeOptions(env: NodeJS.ProcessEnv): DiscordScopeOptions {
	return {
		allowedGuildIds: parseDiscordIdAllowlist(env.CLANKY_DISCORD_ALLOWED_GUILD_IDS),
		allowedChannelIds: parseDiscordIdAllowlist(env.CLANKY_DISCORD_ALLOWED_CHANNEL_IDS),
		allowDms: resolveDiscordAllowDms(env),
	};
}

/** Bound on distinct channel+user pairs remembered at once; LRU beyond this. */
const MAX_ENGAGEMENT_ENTRIES = 4096;

/**
 * Tracks recent engagement per channel+user so short follow-ups land without a
 * re-mention. The clock is injectable to keep the logic pure and testable.
 * Entries expire at the window edge (TTL) and are capped, so channel+user
 * pairs never seen again do not accumulate for the brain's whole uptime.
 */
export class EngagementTracker {
	private readonly engaged: TtlCache<string, true>;

	constructor(windowMs: number = DEFAULT_ENGAGEMENT_WINDOW_MS, now: () => number = Date.now) {
		this.engaged = new TtlCache({ maxEntries: MAX_ENGAGEMENT_ENTRIES, ttlMs: windowMs, now });
	}

	private key(channelId: string, userId: string): string {
		return `${channelId}\u0000${userId}`;
	}

	record(channelId: string, userId: string): void {
		this.engaged.set(this.key(channelId, userId), true);
	}

	isEngaged(channelId: string, userId: string): boolean {
		return this.engaged.get(this.key(channelId, userId)) === true;
	}

	clear(channelId: string, userId: string): void {
		this.engaged.delete(this.key(channelId, userId));
	}
}
