/**
 * Turns an accepted Discord message into the model-facing prompt for a presence
 * turn (SPEC.md §5.2). Pure and testable. Carries the [SKIP] free-will contract
 * and the channel metadata the agent needs to act and reply in the right place.
 */
import type { DiscordAcceptanceReason, DiscordInboundMessage } from "./acceptance.ts";

export interface DiscordHistoryEntry {
	author: string;
	text: string;
}

export function acceptanceReasonForPrompt(reason: DiscordAcceptanceReason): string {
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

export function formatPresencePrompt(
	message: DiscordInboundMessage,
	reason: DiscordAcceptanceReason,
	sender: string,
	history: readonly DiscordHistoryEntry[] = [],
): string {
	const text = message.text.trim() || "(no text)";
	const historyBlock = history
		.slice(-20)
		.map((entry) => `- ${entry.author}: ${entry.text}`)
		.join("\n");
	return [
		"Discord conversation update:",
		"",
		"You are participating in an ongoing Discord chat. Zoom out before replying: use the recent context, the newest message, and any tool actions you take this turn to decide whether the channel needs another visible message from you.",
		"",
		`Bridge context: ${acceptanceReasonForPrompt(reason)}`,
		"If no additional visible Discord response is needed, reply with exactly [SKIP].",
		"If a tool action you took already satisfies the request, reply with exactly [SKIP] instead of a duplicate confirmation.",
		"Only send text when it adds something beyond actions already taken.",
		"For heavy work (web, code, builds, research) delegate with herdr_spawn instead of blocking this reply; use herdr_status/herdr_read to see what main Clanky and other panes are doing.",
		"",
		"Discord conversation:",
		`- kind: ${message.kind}`,
		`- channelId: ${message.channelId}`,
		...(message.threadId === undefined ? [] : [`- threadId: ${message.threadId}`]),
		...(message.guildId === undefined ? [] : [`- serverId: ${message.guildId}`]),
		`- newestMessageId: ${message.externalMessageId}`,
		"",
		...(historyBlock.length > 0 ? ["Recent chat before the newest message:", historyBlock, ""] : []),
		"Newest Discord message:",
		`From: ${sender}`,
		`Text: ${text}`,
	]
		.filter((line) => line.length > 0 || line === "")
		.join("\n");
}
