import type { MessageEvent } from "./types.ts";

export interface AllowListConfig {
	allowedUsers?: readonly string[];
	allowedChats?: readonly string[];
	allowedGuilds?: readonly string[];
	deniedUsers?: readonly string[];
	deniedChats?: readonly string[];
	requireMentionInGroups?: boolean;
	freeResponseChats?: readonly string[];
}

export type AllowListDecision =
	| { allowed: true }
	| {
			allowed: false;
			reason: "user_denied" | "user_not_allowed" | "chat_not_allowed" | "guild_not_allowed" | "mention_required";
	  };

export class AllowList {
	private readonly allowedUsers: ReadonlySet<string>;
	private readonly allowedChats: ReadonlySet<string>;
	private readonly allowedGuilds: ReadonlySet<string>;
	private readonly deniedUsers: ReadonlySet<string>;
	private readonly deniedChats: ReadonlySet<string>;
	private readonly requireMentionInGroups: boolean;
	private readonly freeResponseChats: ReadonlySet<string>;

	constructor(config: AllowListConfig = {}) {
		this.allowedUsers = new Set(config.allowedUsers ?? []);
		this.allowedChats = new Set(config.allowedChats ?? []);
		this.allowedGuilds = new Set(config.allowedGuilds ?? []);
		this.deniedUsers = new Set(config.deniedUsers ?? []);
		this.deniedChats = new Set(config.deniedChats ?? []);
		this.requireMentionInGroups = config.requireMentionInGroups ?? false;
		this.freeResponseChats = new Set(config.freeResponseChats ?? []);
	}

	check(event: MessageEvent, options: { guildId?: string } = {}): AllowListDecision {
		if (this.deniedUsers.has(event.userId)) return { allowed: false, reason: "user_denied" };
		if (this.deniedChats.has(event.chatId)) return { allowed: false, reason: "user_denied" };
		if (this.allowedUsers.size > 0 && !this.allowedUsers.has(event.userId)) {
			return { allowed: false, reason: "user_not_allowed" };
		}
		if (event.chatType !== "dm" && this.allowedChats.size > 0 && !this.allowedChats.has(event.chatId)) {
			return { allowed: false, reason: "chat_not_allowed" };
		}
		if (options.guildId !== undefined && this.allowedGuilds.size > 0 && !this.allowedGuilds.has(options.guildId)) {
			return { allowed: false, reason: "guild_not_allowed" };
		}
		if (this.requireMentionInGroups && event.chatType !== "dm" && !event.mentionsBot) {
			if (this.freeResponseChats.has(event.chatId)) return { allowed: true };
			return { allowed: false, reason: "mention_required" };
		}
		return { allowed: true };
	}
}
