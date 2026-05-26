import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import type { AuthStorage } from "@earendil-works/pi-coding-agent";
import {
	type ClankyDiscordCredentialKind,
	DEFAULT_CLANKY_DISCORD_PROVIDER_ID,
	loadStoredDiscordCredential,
} from "../discord-credentials.ts";

const DISCORD_API_BASE = "https://discord.com/api/v10";
const DISCORD_USER_AGENT = "Clanky (clanky-pi discord operator)";
const DISCORD_EPOCH_MS = 1_420_070_400_000n;
const DEFAULT_RECENT_ACTIVITY_SINCE = "7d";
const DEFAULT_RECENT_ACTIVITY_CHANNEL_LIMIT = 5;
const DEFAULT_RECENT_ACTIVITY_MESSAGE_LIMIT = 10;
const TEXT_CHANNEL_TYPES = new Set([0, 5, 10, 11, 12]);

export interface DiscordOperatorOptions {
	authStorage?: AuthStorage;
	env?: NodeJS.ProcessEnv;
	signal?: AbortSignal;
}

export interface ResolvedDiscordCredential {
	providerId: string;
	token: string;
	credentialKind: ClankyDiscordCredentialKind;
	source: "env" | "stored";
}

export interface DiscordGuildSummary {
	id: string;
	name: string;
	owner?: boolean;
	permissions?: string;
}

export interface DiscordChannelSummary {
	id: string;
	name?: string;
	type: number;
	guildId?: string;
	parentId?: string;
	lastMessageId?: string;
	lastMessageAt?: string;
}

export interface DiscordMessageSummary {
	id: string;
	channelId: string;
	authorId?: string;
	authorUsername?: string;
	content: string;
	timestamp?: string;
	attachmentUrls: string[];
}

export interface DiscordEmojiSummary {
	id: string;
	name: string;
	animated: boolean;
	reaction: string;
}

export interface DiscordParticipantSummary {
	authorId?: string;
	authorUsername?: string;
	messageCount: number;
}

export interface DiscordRecentChannelActivitySummary {
	channelId: string;
	channelName?: string;
	type: number;
	parentId?: string;
	lastMessageId?: string;
	lastMessageAt?: string;
	messageCount: number;
	topParticipants: DiscordParticipantSummary[];
	messages?: DiscordMessageSummary[];
}

export interface DiscordRecentActivityResult {
	guildId: string;
	guildName?: string;
	sinceTimestamp: string;
	generatedAt: string;
	activeChannelCount: number;
	channels: DiscordRecentChannelActivitySummary[];
}

export interface DiscordSendMessageInput {
	channelId?: string;
	channel_id?: string;
	content?: string;
	replyToMessageId?: string;
	reply_to_message_id?: string;
	filePaths?: string[];
	file_paths?: string[];
}

export interface DiscordReadMessagesInput {
	channelId?: string;
	channel_id?: string;
	limit?: number;
	before?: string;
	after?: string;
	around?: string;
	since?: string;
	sinceTimestamp?: string;
	since_timestamp?: string;
	until?: string;
	untilTimestamp?: string;
	until_timestamp?: string;
}

export interface DiscordListChannelsInput {
	guildId?: string;
	guild_id?: string;
	since?: string;
	sinceTimestamp?: string;
	since_timestamp?: string;
}

export interface DiscordRecentActivityInput {
	guildId?: string;
	guild_id?: string;
	since?: string;
	sinceTimestamp?: string;
	since_timestamp?: string;
	channelIds?: string[];
	channel_ids?: string[];
	channelNameQuery?: string;
	channel_name_query?: string;
	limitChannels?: number;
	limit_channels?: number;
	messageLimit?: number;
	message_limit?: number;
	includeMessages?: boolean;
	include_messages?: boolean;
}

export interface DiscordListEmojisInput {
	guildId?: string;
	guild_id?: string;
}

export interface DiscordAddReactionInput {
	channelId?: string;
	channel_id?: string;
	messageId?: string;
	message_id?: string;
	emoji: string;
}

export interface DiscordSendMessageResult {
	ok: true;
	message: DiscordMessageSummary;
	attachmentsUploaded: number;
}

export interface DiscordAddReactionResult {
	ok: true;
	channelId: string;
	messageId: string;
	emoji: string;
}

export function resolveDiscordOperatorCredential(options: DiscordOperatorOptions = {}): ResolvedDiscordCredential {
	const env = options.env ?? process.env;
	const providerId = env.CLANKY_DISCORD_PROVIDER_ID?.trim() || DEFAULT_CLANKY_DISCORD_PROVIDER_ID;
	const envToken = env.CLANKY_DISCORD_TOKEN?.trim();
	if (envToken !== undefined && envToken.length > 0) {
		return {
			providerId,
			token: envToken,
			credentialKind: parseDiscordCredentialKind(env.CLANKY_DISCORD_CREDENTIAL_KIND?.trim()),
			source: "env",
		};
	}
	if (options.authStorage !== undefined) {
		const stored = loadStoredDiscordCredential(options.authStorage, providerId);
		if (stored !== undefined) {
			return {
				providerId: stored.providerId,
				token: stored.payload.token,
				credentialKind: stored.payload.credentialKind,
				source: "stored",
			};
		}
	}
	throw new Error(
		"Discord credentials missing: set CLANKY_DISCORD_TOKEN or run /discord-login to store clanky-discord credentials.",
	);
}

export async function listDiscordGuilds(options: DiscordOperatorOptions = {}): Promise<DiscordGuildSummary[]> {
	const json = await discordRequest("GET", "/users/@me/guilds", options);
	if (!Array.isArray(json)) throw new Error("Discord guild list response was not an array.");
	return json.map((item) => {
		const record = expectRecord(item, "guild");
		return {
			id: expectString(record.id, "guild.id"),
			name: expectString(record.name, "guild.name"),
			...(typeof record.owner === "boolean" ? { owner: record.owner } : {}),
			...(typeof record.permissions === "string" ? { permissions: record.permissions } : {}),
		};
	});
}

export async function listDiscordChannels(
	input: DiscordListChannelsInput,
	options: DiscordOperatorOptions = {},
): Promise<DiscordChannelSummary[]> {
	const guildId = required(input.guildId ?? input.guild_id, "guildId");
	const since = resolveOptionalTimeBoundary(input.since ?? input.sinceTimestamp ?? input.since_timestamp, "since");
	const json = await discordRequest("GET", `/guilds/${encodeURIComponent(guildId)}/channels`, options);
	if (!Array.isArray(json)) throw new Error("Discord channel list response was not an array.");
	const channels = json.map(formatDiscordChannel);
	if (since === undefined) return channels;
	const sinceMs = since.getTime();
	return channels.filter((channel) => {
		if (channel.lastMessageAt === undefined) return false;
		const lastMessageMs = Date.parse(channel.lastMessageAt);
		return Number.isFinite(lastMessageMs) && lastMessageMs >= sinceMs;
	});
}

export async function readDiscordMessages(
	input: DiscordReadMessagesInput,
	options: DiscordOperatorOptions = {},
): Promise<DiscordMessageSummary[]> {
	const channelId = required(input.channelId ?? input.channel_id, "channelId");
	const limit = clampMessageLimit(input.limit ?? 20);
	const since = resolveOptionalTimeBoundary(input.since ?? input.sinceTimestamp ?? input.since_timestamp, "since");
	const until = resolveOptionalTimeBoundary(input.until ?? input.untilTimestamp ?? input.until_timestamp, "until");
	if (since === undefined && until === undefined) {
		const query = new URLSearchParams();
		query.set("limit", String(limit));
		if (input.before !== undefined) query.set("before", input.before);
		if (input.after !== undefined) query.set("after", input.after);
		if (input.around !== undefined) query.set("around", input.around);
		const json = await discordRequest("GET", `/channels/${encodeURIComponent(channelId)}/messages?${query}`, options);
		if (!Array.isArray(json)) throw new Error("Discord messages response was not an array.");
		return json.map(formatDiscordMessage);
	}
	if (input.around !== undefined) {
		throw new Error("discord_read_messages does not support around together with since/until filters.");
	}
	return await readDiscordMessagesWithinWindow(
		{
			channelId,
			limit,
			...(input.before === undefined ? {} : { before: input.before }),
			...(input.after === undefined ? {} : { after: input.after }),
		},
		options,
		since,
		until,
	);
}

export async function recentDiscordActivity(
	input: DiscordRecentActivityInput,
	options: DiscordOperatorOptions = {},
): Promise<DiscordRecentActivityResult> {
	const guildIdInput = input.guildId ?? input.guild_id;
	const guilds =
		guildIdInput === undefined || guildIdInput.trim().length === 0 ? await listDiscordGuilds(options) : undefined;
	const guildId =
		guildIdInput !== undefined && guildIdInput.trim().length > 0
			? guildIdInput.trim()
			: guilds?.length === 1
				? guilds[0]?.id
				: undefined;
	if (guildId === undefined) {
		throw new Error("discord_recent_activity requires guildId unless exactly one visible guild is available.");
	}
	const guildName = guilds?.find((guild) => guild.id === guildId)?.name;
	const since =
		resolveOptionalTimeBoundary(input.since ?? input.sinceTimestamp ?? input.since_timestamp, "since") ??
		parseTimeBoundary(DEFAULT_RECENT_ACTIVITY_SINCE, "since");
	const sinceTimestamp = since.toISOString();
	const limitChannels = clampPositiveInt(
		input.limitChannels ?? input.limit_channels,
		DEFAULT_RECENT_ACTIVITY_CHANNEL_LIMIT,
		25,
	);
	const messageLimit = clampMessageLimit(
		input.messageLimit ?? input.message_limit ?? DEFAULT_RECENT_ACTIVITY_MESSAGE_LIMIT,
	);
	const includeMessages = input.includeMessages ?? input.include_messages ?? true;
	const requestedChannelIds = new Set(normalizeIdList(input.channelIds ?? input.channel_ids));
	const channelNameQuery = normalizeQuery(input.channelNameQuery ?? input.channel_name_query);

	const channels = await listDiscordChannels(
		{
			guildId,
			sinceTimestamp,
		},
		options,
	);
	const matchingChannels = channels
		.filter((channel) => isTextChannelType(channel.type))
		.filter((channel) => requestedChannelIds.size === 0 || requestedChannelIds.has(channel.id))
		.filter(
			(channel) => channelNameQuery === undefined || normalizeQuery(channel.name)?.includes(channelNameQuery) === true,
		)
		.sort(compareChannelsByRecentActivity);
	const activeChannels = matchingChannels.slice(0, limitChannels);

	const channelResults = await Promise.all(
		activeChannels.map(async (channel) => {
			const messages = await readDiscordMessages(
				{
					channelId: channel.id,
					limit: messageLimit,
					sinceTimestamp,
				},
				options,
			);
			if (messages.length === 0) return undefined;
			const topParticipants = summarizeParticipants(messages);
			const summary: DiscordRecentChannelActivitySummary = {
				channelId: channel.id,
				type: channel.type,
				messageCount: messages.length,
				topParticipants,
				...(channel.name === undefined ? {} : { channelName: channel.name }),
				...(channel.parentId === undefined ? {} : { parentId: channel.parentId }),
				...(channel.lastMessageId === undefined ? {} : { lastMessageId: channel.lastMessageId }),
				...(channel.lastMessageAt === undefined ? {} : { lastMessageAt: channel.lastMessageAt }),
				...(includeMessages ? { messages } : {}),
			};
			return summary;
		}),
	);

	return {
		guildId,
		...(guildName === undefined ? {} : { guildName }),
		sinceTimestamp,
		generatedAt: new Date().toISOString(),
		activeChannelCount: matchingChannels.length,
		channels: channelResults.filter(isDefined),
	};
}

export async function sendDiscordMessage(
	input: DiscordSendMessageInput,
	options: DiscordOperatorOptions = {},
): Promise<DiscordSendMessageResult> {
	const channelId = required(input.channelId ?? input.channel_id, "channelId");
	const content = input.content?.trim();
	const filePaths = input.filePaths ?? input.file_paths ?? [];
	if ((content === undefined || content.length === 0) && filePaths.length === 0) {
		throw new Error("discord_send_message requires content or at least one file path.");
	}

	let body: BodyInit;
	let headers: Record<string, string> | undefined;
	const replyToMessageId = input.replyToMessageId ?? input.reply_to_message_id;
	const payload: Record<string, unknown> = {};
	if (content !== undefined && content.length > 0) payload.content = content;
	if (replyToMessageId !== undefined && replyToMessageId.trim().length > 0) {
		payload.message_reference = { message_id: replyToMessageId.trim() };
	}

	if (filePaths.length > 0) {
		const form = new FormData();
		form.append("payload_json", JSON.stringify(payload));
		for (let index = 0; index < filePaths.length; index++) {
			const filePath = filePaths[index];
			if (filePath === undefined || filePath.trim().length === 0) continue;
			const data = await readFile(filePath);
			form.append(`files[${index}]`, new Blob([data]), basename(filePath));
		}
		body = form;
	} else {
		body = JSON.stringify(payload);
		headers = { "Content-Type": "application/json" };
	}

	const json = await discordRequest(
		"POST",
		`/channels/${encodeURIComponent(channelId)}/messages`,
		options,
		body,
		headers,
	);
	return { ok: true, message: formatDiscordMessage(json), attachmentsUploaded: filePaths.length };
}

export async function listDiscordEmojis(
	input: DiscordListEmojisInput,
	options: DiscordOperatorOptions = {},
): Promise<DiscordEmojiSummary[]> {
	const guildId = required(input.guildId ?? input.guild_id, "guildId");
	const json = await discordRequest("GET", `/guilds/${encodeURIComponent(guildId)}/emojis`, options);
	if (!Array.isArray(json)) throw new Error("Discord emoji list response was not an array.");
	return json.map((item) => {
		const record = expectRecord(item, "emoji");
		const id = expectString(record.id, "emoji.id");
		const name = expectString(record.name, "emoji.name");
		const animated = record.animated === true;
		return { id, name, animated, reaction: `${animated ? "a:" : ""}${name}:${id}` };
	});
}

export async function addDiscordReaction(
	input: DiscordAddReactionInput,
	options: DiscordOperatorOptions = {},
): Promise<DiscordAddReactionResult> {
	const channelId = required(input.channelId ?? input.channel_id, "channelId");
	const messageId = required(input.messageId ?? input.message_id, "messageId");
	const emoji = required(input.emoji, "emoji");
	await discordRequest(
		"PUT",
		`/channels/${encodeURIComponent(channelId)}/messages/${encodeURIComponent(messageId)}/reactions/${encodeURIComponent(emoji)}/@me`,
		options,
	);
	return { ok: true, channelId, messageId, emoji };
}

async function readDiscordMessagesWithinWindow(
	input: { channelId: string; limit: number; before?: string; after?: string },
	options: DiscordOperatorOptions,
	since: Date | undefined,
	until: Date | undefined,
): Promise<DiscordMessageSummary[]> {
	const lowerBoundId = maxDiscordSnowflake(
		trimToUndefined(input.after),
		since === undefined ? undefined : timestampToDiscordSnowflake(since.getTime()),
	);
	const upperBoundId = minDiscordSnowflake(
		trimToUndefined(input.before),
		until === undefined ? undefined : timestampToDiscordSnowflake(until.getTime() + 1),
	);
	const results: DiscordMessageSummary[] = [];
	let beforeCursor = upperBoundId;
	while (results.length < input.limit) {
		const batchLimit = Math.min(100, Math.max(input.limit * 2, 25));
		const query = new URLSearchParams();
		query.set("limit", String(batchLimit));
		if (beforeCursor !== undefined) query.set("before", beforeCursor);
		const json = await discordRequest(
			"GET",
			`/channels/${encodeURIComponent(input.channelId)}/messages?${query}`,
			options,
		);
		if (!Array.isArray(json)) throw new Error("Discord messages response was not an array.");
		const batch = json.map(formatDiscordMessage).sort(compareMessagesNewestFirst);
		if (batch.length === 0) break;
		let reachedLowerBound = false;
		for (const message of batch) {
			if (lowerBoundId !== undefined && compareDiscordSnowflakes(message.id, lowerBoundId) <= 0) {
				reachedLowerBound = true;
				break;
			}
			const messageTimestamp = resolveMessageTimestampMs(message);
			if (until !== undefined && messageTimestamp !== undefined && messageTimestamp > until.getTime()) {
				continue;
			}
			if (since !== undefined && messageTimestamp !== undefined && messageTimestamp < since.getTime()) {
				reachedLowerBound = true;
				break;
			}
			results.push(message);
			if (results.length >= input.limit) break;
		}
		const oldest = batch[batch.length - 1];
		if (results.length >= input.limit || batch.length < batchLimit || oldest === undefined || reachedLowerBound) break;
		if (beforeCursor === oldest.id) break;
		beforeCursor = oldest.id;
	}
	return results.slice(0, input.limit);
}

async function discordRequest(
	method: string,
	path: string,
	options: DiscordOperatorOptions,
	body?: BodyInit,
	extraHeaders: Record<string, string> = {},
): Promise<unknown> {
	const credential = resolveDiscordOperatorCredential(options);
	const authorization = credential.credentialKind === "bot-token" ? `Bot ${credential.token}` : credential.token;
	const response = await fetch(`${DISCORD_API_BASE}${path}`, {
		method,
		headers: {
			Authorization: authorization,
			"User-Agent": DISCORD_USER_AGENT,
			...extraHeaders,
		},
		...(body === undefined ? {} : { body }),
		...(options.signal === undefined ? {} : { signal: options.signal }),
	});
	if (!response.ok) {
		const text = await response.text().catch(() => "");
		throw new Error(
			`Discord API ${method} ${path} failed: ${response.status} ${response.statusText}${text.length > 0 ? `: ${text.slice(0, 500)}` : ""}`,
		);
	}
	if (response.status === 204) return undefined;
	return await response.json();
}

function parseDiscordCredentialKind(value: string | undefined): ClankyDiscordCredentialKind {
	return value === "user-token" ? "user-token" : "bot-token";
}

function formatDiscordChannel(item: unknown): DiscordChannelSummary {
	const record = expectRecord(item, "channel");
	const lastMessageId = typeof record.last_message_id === "string" ? record.last_message_id : undefined;
	const lastMessageTimestamp = lastMessageId === undefined ? undefined : discordSnowflakeToTimestamp(lastMessageId);
	return {
		id: expectString(record.id, "channel.id"),
		type: expectNumber(record.type, "channel.type"),
		...(typeof record.name === "string" ? { name: record.name } : {}),
		...(typeof record.guild_id === "string" ? { guildId: record.guild_id } : {}),
		...(typeof record.parent_id === "string" ? { parentId: record.parent_id } : {}),
		...(lastMessageId === undefined ? {} : { lastMessageId }),
		...(lastMessageTimestamp === undefined ? {} : { lastMessageAt: new Date(lastMessageTimestamp).toISOString() }),
	};
}

function formatDiscordMessage(item: unknown): DiscordMessageSummary {
	const record = expectRecord(item, "message");
	const author =
		typeof record.author === "object" && record.author !== null
			? (record.author as Record<string, unknown>)
			: undefined;
	const attachments = Array.isArray(record.attachments) ? record.attachments : [];
	return {
		id: expectString(record.id, "message.id"),
		channelId: expectString(record.channel_id, "message.channel_id"),
		content: typeof record.content === "string" ? record.content : "",
		attachmentUrls: attachments.flatMap((attachment) => {
			if (typeof attachment !== "object" || attachment === null) return [];
			const url = (attachment as Record<string, unknown>).url;
			return typeof url === "string" ? [url] : [];
		}),
		...(author !== undefined && typeof author.id === "string" ? { authorId: author.id } : {}),
		...(author !== undefined && typeof author.username === "string" ? { authorUsername: author.username } : {}),
		...(typeof record.timestamp === "string" ? { timestamp: record.timestamp } : {}),
	};
}

function summarizeParticipants(messages: readonly DiscordMessageSummary[]): DiscordParticipantSummary[] {
	const counts = new Map<string, DiscordParticipantSummary>();
	for (const message of messages) {
		const authorKey = message.authorId ?? `username:${message.authorUsername ?? "unknown"}`;
		const existing = counts.get(authorKey);
		if (existing !== undefined) {
			existing.messageCount += 1;
			continue;
		}
		counts.set(authorKey, {
			...(message.authorId === undefined ? {} : { authorId: message.authorId }),
			...(message.authorUsername === undefined ? {} : { authorUsername: message.authorUsername }),
			messageCount: 1,
		});
	}
	return [...counts.values()].sort(
		(left, right) =>
			right.messageCount - left.messageCount ||
			(left.authorUsername ?? left.authorId ?? "").localeCompare(right.authorUsername ?? right.authorId ?? ""),
	);
}

function clampMessageLimit(limit: number): number {
	if (!Number.isFinite(limit)) return 20;
	return Math.max(1, Math.min(100, Math.floor(limit)));
}

function clampPositiveInt(value: number | undefined, fallback: number, maximum: number): number {
	if (value === undefined || !Number.isFinite(value)) return fallback;
	return Math.max(1, Math.min(maximum, Math.floor(value)));
}

function required(value: string | undefined, label: string): string {
	if (value === undefined || value.trim().length === 0) throw new Error(`${label} is required.`);
	return value.trim();
}

function expectRecord(value: unknown, label: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`Expected ${label} object.`);
	return value as Record<string, unknown>;
}

function expectString(value: unknown, label: string): string {
	if (typeof value !== "string") throw new Error(`Expected ${label} string.`);
	return value;
}

function expectNumber(value: unknown, label: string): number {
	if (typeof value !== "number") throw new Error(`Expected ${label} number.`);
	return value;
}

function normalizeIdList(values: readonly string[] | undefined): string[] {
	if (values === undefined) return [];
	return values.flatMap((value) => {
		const trimmed = value.trim();
		return trimmed.length === 0 ? [] : [trimmed];
	});
}

function normalizeQuery(value: string | undefined): string | undefined {
	const trimmed = value?.trim().toLowerCase();
	return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
}

function resolveOptionalTimeBoundary(value: string | undefined, label: string): Date | undefined {
	const trimmed = value?.trim();
	if (trimmed === undefined || trimmed.length === 0) return undefined;
	return parseTimeBoundary(trimmed, label);
}

function parseTimeBoundary(value: string, label: string): Date {
	const relativeDurationMs = parseRelativeDurationMs(value);
	if (relativeDurationMs !== undefined) return new Date(Date.now() - relativeDurationMs);
	const parsed = Date.parse(value);
	if (Number.isFinite(parsed)) return new Date(parsed);
	throw new Error(`${label} must be an ISO timestamp or relative duration like 30m, 24h, or 7d.`);
}

function parseRelativeDurationMs(value: string): number | undefined {
	const match = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d|w)$/i.exec(value.trim());
	const rawAmount = match?.[1];
	const rawUnit = match?.[2];
	if (rawAmount === undefined || rawUnit === undefined) return undefined;
	const amount = Number.parseFloat(rawAmount);
	if (!Number.isFinite(amount) || amount < 0) return undefined;
	const unit = rawUnit.toLowerCase();
	const multiplier =
		unit === "ms"
			? 1
			: unit === "s"
				? 1_000
				: unit === "m"
					? 60_000
					: unit === "h"
						? 3_600_000
						: unit === "d"
							? 86_400_000
							: 604_800_000;
	return amount * multiplier;
}

function isTextChannelType(type: number): boolean {
	return TEXT_CHANNEL_TYPES.has(type);
}

function compareChannelsByRecentActivity(left: DiscordChannelSummary, right: DiscordChannelSummary): number {
	const leftId = left.lastMessageId;
	const rightId = right.lastMessageId;
	if (leftId !== undefined && rightId !== undefined) return compareDiscordSnowflakes(rightId, leftId);
	if (leftId !== undefined) return -1;
	if (rightId !== undefined) return 1;
	return (left.name ?? left.id).localeCompare(right.name ?? right.id);
}

function compareMessagesNewestFirst(left: DiscordMessageSummary, right: DiscordMessageSummary): number {
	return compareDiscordSnowflakes(right.id, left.id);
}

function resolveMessageTimestampMs(message: DiscordMessageSummary): number | undefined {
	if (message.timestamp !== undefined) {
		const parsed = Date.parse(message.timestamp);
		if (Number.isFinite(parsed)) return parsed;
	}
	return discordSnowflakeToTimestamp(message.id);
}

function discordSnowflakeToTimestamp(value: string): number | undefined {
	try {
		const snowflake = BigInt(value);
		return Number((snowflake >> 22n) + DISCORD_EPOCH_MS);
	} catch {
		return undefined;
	}
}

function timestampToDiscordSnowflake(timestampMs: number): string {
	const safeTimestampMs = BigInt(Math.max(0, Math.floor(timestampMs)));
	return ((safeTimestampMs - DISCORD_EPOCH_MS) << 22n).toString();
}

function compareDiscordSnowflakes(left: string, right: string): number {
	try {
		const leftValue = BigInt(left);
		const rightValue = BigInt(right);
		if (leftValue < rightValue) return -1;
		if (leftValue > rightValue) return 1;
		return 0;
	} catch {
		return left.localeCompare(right);
	}
}

function maxDiscordSnowflake(left: string | undefined, right: string | undefined): string | undefined {
	if (left === undefined) return right;
	if (right === undefined) return left;
	return compareDiscordSnowflakes(left, right) >= 0 ? left : right;
}

function minDiscordSnowflake(left: string | undefined, right: string | undefined): string | undefined {
	if (left === undefined) return right;
	if (right === undefined) return left;
	return compareDiscordSnowflakes(left, right) <= 0 ? left : right;
}

function trimToUndefined(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
}

function isDefined<T>(value: T | undefined): value is T {
	return value !== undefined;
}
