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

export type DiscordPresencePromptMode = "full" | "compact";

const FULL_HISTORY_LIMIT = 20;
const COMPACT_HISTORY_LIMIT = 6;
const MIRROR_PREVIEW_LIMIT = 220;

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
	return formatDiscordPresencePrompt(message, reason, sender, history, "full");
}

export function formatCompactPresencePrompt(
	message: DiscordInboundMessage,
	reason: DiscordAcceptanceReason,
	sender: string,
	history: readonly DiscordHistoryEntry[] = [],
): string {
	return formatDiscordPresencePrompt(message, reason, sender, history, "compact");
}

export function summarizePresencePromptForMirror(prompt: string): string | null {
	if (!prompt.startsWith("Discord conversation update:") && !prompt.startsWith("Discord follow-up:")) return null;
	const kind = readListValue(prompt, "kind");
	const sender = readLineValue(prompt, "From");
	const rawText = readPromptText(prompt);
	const text = previewText(rawText.length === 0 ? "(no text)" : rawText, MIRROR_PREVIEW_LIMIT);
	const prefix = kind.length === 0 ? "Discord" : `Discord ${kind}`;
	return sender.length === 0 ? `${prefix}: ${text}` : `${prefix} ${sender}: ${text}`;
}

function formatDiscordPresencePrompt(
	message: DiscordInboundMessage,
	reason: DiscordAcceptanceReason,
	sender: string,
	history: readonly DiscordHistoryEntry[],
	mode: DiscordPresencePromptMode,
): string {
	const text = message.text.trim() || "(no text)";
	const historyLimit = mode === "full" ? FULL_HISTORY_LIMIT : message.kind === "dm" ? 0 : COMPACT_HISTORY_LIMIT;
	const historyBlock = formatHistoryBlock(history, historyLimit);
	const attachmentBlock = formatAttachmentBlock(message);
	const embedBlock = formatEmbedBlock(message);
	if (mode === "compact") {
		return [
			"Discord follow-up:",
			`- context: ${acceptanceReasonForPrompt(reason)}`,
			...formatConversationLines(message),
			"- reply policy: continue the existing Discord presence contract; answer only when useful, otherwise reply exactly [SKIP].",
			"- do not call discord_read_messages just to re-read this channel.",
			"",
			...(historyBlock.length > 0 ? ["Recent gateway context:", historyBlock, ""] : []),
			...(attachmentBlock.length > 0 ? ["Discord attachments on the newest message:", attachmentBlock, ""] : []),
			...(embedBlock.length > 0 ? ["Discord embeds/previews on the newest message:", embedBlock, ""] : []),
			"Newest Discord message:",
			`From: ${sender}`,
			`Text: ${text}`,
		].join("\n");
	}
	return [
		"Discord conversation update:",
		"",
		"You are participating in an ongoing Discord chat. Zoom out before replying: use the recent context, the newest message, and any tool actions you take this turn to decide whether the channel needs another visible message from you.",
		"",
		`Bridge context: ${acceptanceReasonForPrompt(reason)}`,
		"If no additional visible Discord response is needed, reply with exactly [SKIP].",
		"If a tool action you took already satisfies the request, reply with exactly [SKIP] instead of a duplicate confirmation.",
		"Only send text when it adds something beyond actions already taken.",
		"The recent chat below came from the live Discord gateway; do not call discord_read_messages just to re-read this channel.",
		"If a Discord tool is genuinely needed, copy channelId/serverId/message ids exactly as shown; never infer or alter numeric ids.",
		"For heavy work (web, code, builds, research) delegate with herdr_spawn instead of blocking this reply; use herdr_status/herdr_read to see what main Clanky and other panes are doing.",
		"",
		"Discord conversation:",
		...formatConversationLines(message),
		"",
		...(historyBlock.length > 0 ? ["Recent chat before the newest message:", historyBlock, ""] : []),
		...(attachmentBlock.length > 0 ? ["Discord attachments on the newest message:", attachmentBlock, ""] : []),
		...(embedBlock.length > 0 ? ["Discord embeds/previews on the newest message:", embedBlock, ""] : []),
		"Newest Discord message:",
		`From: ${sender}`,
		`Text: ${text}`,
	].join("\n");
}

function formatHistoryBlock(history: readonly DiscordHistoryEntry[], limit: number): string {
	if (limit <= 0) return "";
	return history
		.slice(-limit)
		.map((entry) => `- ${entry.author}: ${entry.text}`)
		.join("\n");
}

function formatConversationLines(message: DiscordInboundMessage): string[] {
	return [
		`- kind: ${message.kind}`,
		`- channelId: ${message.channelId}`,
		...(message.threadId === undefined ? [] : [`- threadId: ${message.threadId}`]),
		...(message.guildId === undefined ? [] : [`- serverId: ${message.guildId}`]),
		`- newestMessageId: ${message.externalMessageId}`,
		`- authorId: ${message.authorId}`,
		...(message.authorName === undefined ? [] : [`- authorName: ${message.authorName}`]),
	];
}

function formatAttachmentBlock(message: DiscordInboundMessage): string {
	return (message.attachments ?? [])
		.map((attachment, index) => {
			const details = [
				`id=${attachment.id}`,
				`url=${attachment.url}`,
				attachment.filename === undefined ? undefined : `filename=${attachment.filename}`,
				attachment.contentType === undefined ? undefined : `type=${attachment.contentType}`,
				attachment.size === undefined ? undefined : `bytes=${attachment.size}`,
				attachment.width === undefined || attachment.height === undefined
					? undefined
					: `size=${attachment.width}x${attachment.height}`,
				attachment.description === undefined ? undefined : `description=${attachment.description}`,
			].filter((part): part is string => part !== undefined);
			return `- attachment ${index + 1}: ${details.join("; ")}`;
		})
		.join("\n");
}

function readListValue(prompt: string, key: string): string {
	const match = new RegExp(`^- ${key}: (.*)$`, "m").exec(prompt);
	return match?.[1]?.trim() ?? "";
}

function readLineValue(prompt: string, key: string): string {
	const match = new RegExp(`^${key}: (.*)$`, "m").exec(prompt);
	return match?.[1]?.trim() ?? "";
}

function readPromptText(prompt: string): string {
	const marker = "\nText: ";
	const index = prompt.lastIndexOf(marker);
	if (index === -1) return "";
	const rest = prompt.slice(index + marker.length);
	const inlineMarker = "\n\nInline visual attachment transfer:";
	const inlineIndex = rest.indexOf(inlineMarker);
	return (inlineIndex === -1 ? rest : rest.slice(0, inlineIndex)).trim();
}

function previewText(value: string, limit: number): string {
	const compact = value.replace(/\s+/g, " ").trim();
	if (compact.length <= limit) return compact;
	return `${compact.slice(0, Math.max(0, limit - 3))}...`;
}

function formatEmbedBlock(message: DiscordInboundMessage): string {
	return (message.embeds ?? [])
		.map((embed, index) => {
			const details = [
				embed.type === undefined ? undefined : `type=${embed.type}`,
				embed.provider === undefined ? undefined : `provider=${embed.provider}`,
				embed.title === undefined ? undefined : `title=${embed.title}`,
				embed.url === undefined ? undefined : `url=${embed.url}`,
				embed.description === undefined ? undefined : `description=${embed.description}`,
				embed.imageUrl === undefined ? undefined : `image=${embed.imageUrl}`,
				embed.thumbnailUrl === undefined ? undefined : `thumbnail=${embed.thumbnailUrl}`,
				embed.videoUrl === undefined ? undefined : `video=${embed.videoUrl}`,
			].filter((part): part is string => part !== undefined);
			return `- embed ${index + 1}: ${details.join("; ")}`;
		})
		.join("\n");
}
