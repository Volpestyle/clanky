import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

const DISCORD_API_BASE = "https://discord.com/api/v10";
const DISCORD_USER_AGENT = "discord-mcp/0.1.0";
const DISCORD_EPOCH_MS = 1_420_070_400_000n;
const DEFAULT_RECENT_ACTIVITY_SINCE = "7d";
const DEFAULT_RECENT_ACTIVITY_CHANNEL_LIMIT = 5;
const DEFAULT_RECENT_ACTIVITY_MESSAGE_LIMIT = 10;
const DEFAULT_RECENT_ATTACHMENTS_MESSAGE_LIMIT = 30;
const DEFAULT_RECENT_ATTACHMENTS_MEDIA_LIMIT = 4;
const DEFAULT_RECENT_ATTACHMENTS_MAX_BYTES = 8 * 1024 * 1024;
const DEFAULT_RECENT_ATTACHMENTS_MAX_VIDEO_BYTES = 25 * 1024 * 1024;
const MAX_RECENT_ATTACHMENTS_MEDIA_LIMIT = 10;
const MAX_RECENT_ATTACHMENTS_MAX_BYTES = 25 * 1024 * 1024;
const MAX_RECENT_ATTACHMENTS_MAX_VIDEO_BYTES = 50 * 1024 * 1024;
const DISCORD_MEDIA_FETCH_TIMEOUT_MS = 10_000;
const DISCORD_VIDEO_KEYFRAME_TIMEOUT_MS = 15_000;
const TEXT_CHANNEL_TYPES = new Set([0, 5, 10, 11, 12]);
const DEFAULT_DISCORD_MCP_PROVIDER_ID = "discord-mcp";

export interface DiscordOperatorOptions {
	env?: NodeJS.ProcessEnv;
	fetchImpl?: typeof fetch;
	signal?: AbortSignal;
	credentialsPath?: string;
}

export type DiscordCredentialKind = "bot-token" | "user-token";

export interface ResolvedDiscordCredential {
	providerId: string;
	token: string;
	credentialKind: DiscordCredentialKind;
	source: "env" | "stored";
}

export interface DiscordStoredCredentialPayload {
	token: string;
	credentialKind: DiscordCredentialKind;
	identity?: DiscordIdentity;
	createdAt: string;
	updatedAt: string;
}

export interface DiscordStoredCredential {
	providerId: string;
	payload: DiscordStoredCredentialPayload;
}

export interface DiscordIdentity {
	id: string;
	username: string;
	globalName?: string;
	bot?: boolean;
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
	attachments: DiscordMessageAttachmentSummary[];
	attachmentUrls: string[];
	media: DiscordMessageMediaSummary[];
	mediaUrls: string[];
}

export interface DiscordMessageAttachmentSummary {
	id?: string;
	url?: string;
	filename?: string;
	contentType?: string;
	size?: number;
}

export type DiscordMessageMediaKind = "image" | "gif" | "video";
export type DiscordMessageMediaSource = "attachment" | "embed" | "link";

export interface DiscordMessageMediaSummary {
	kind: DiscordMessageMediaKind;
	source: DiscordMessageMediaSource;
	url: string;
	originalUrl?: string;
	proxyUrl?: string;
	filename?: string;
	contentType?: string;
	size?: number;
	width?: number;
	height?: number;
	sourceDetail?: string;
	embedType?: string;
	providerName?: string;
	title?: string;
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
	channel_id?: string;
	content?: string;
	reply_to_message_id?: string;
	file_paths?: string[];
}

export interface DiscordReadMessagesInput {
	channel_id?: string;
	limit?: number;
	before?: string;
	after?: string;
	around?: string;
	since?: string;
	until?: string;
}

export interface DiscordListChannelsInput {
	guild_id?: string;
	since?: string;
}

export interface DiscordRecentActivityInput {
	guild_id?: string;
	since?: string;
	channel_ids?: string[];
	channel_name_query?: string;
	limit_channels?: number;
	message_limit?: number;
	include_messages?: boolean;
}

export interface DiscordRecentAttachmentsInput {
	channel_id?: string;
	message_id?: string;
	limit?: number;
	message_limit?: number;
	media_limit?: number;
	before?: string;
	after?: string;
	around?: string;
	since?: string;
	until?: string;
	load?: boolean;
	load_images?: boolean;
	include_video_keyframes?: boolean;
	max_bytes?: number;
	max_video_bytes?: number;
}

export interface DiscordListEmojisInput {
	guild_id?: string;
}

export interface DiscordAddReactionInput {
	channel_id?: string;
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

export type DiscordRecentAttachmentStatus = "loaded" | "metadata_only" | "failed";

export interface DiscordRecentAttachmentMediaResult extends DiscordMessageMediaSummary {
	mediaIndex: number;
	messageId: string;
	channelId: string;
	authorId?: string;
	authorUsername?: string;
	timestamp?: string;
	status: DiscordRecentAttachmentStatus;
	statusReason?: string;
}

export interface DiscordRecentAttachmentLoadedImageSummary {
	imageIndex: number;
	mediaIndex: number;
	messageId: string;
	channelId: string;
	url: string;
	source: DiscordMessageMediaSource;
	kind: DiscordMessageMediaKind;
	mimeType: string;
	authorId?: string;
	authorUsername?: string;
	timestamp?: string;
	generatedFromVideo?: boolean;
}

export interface DiscordRecentAttachmentFailure {
	mediaIndex: number;
	messageId: string;
	url: string;
	reason: string;
}

export interface DiscordLoadedImageContent {
	type: "image";
	data: string;
	mimeType: string;
}

export interface DiscordRecentAttachmentsResult {
	channelId: string;
	targetMessageId?: string;
	targetMessageFound?: boolean;
	generatedAt: string;
	scannedMessageCount: number;
	mediaCount: number;
	loadedImageCount: number;
	media: DiscordRecentAttachmentMediaResult[];
	loadedImages: DiscordRecentAttachmentLoadedImageSummary[];
	failures: DiscordRecentAttachmentFailure[];
	imageContents: DiscordLoadedImageContent[];
}

export function resolveDiscordOperatorCredential(options: DiscordOperatorOptions = {}): ResolvedDiscordCredential {
	const env = options.env ?? process.env;
	const providerId = env.DISCORD_MCP_PROVIDER_ID?.trim() || DEFAULT_DISCORD_MCP_PROVIDER_ID;
	const envToken = env.DISCORD_MCP_TOKEN?.trim();
	if (envToken !== undefined && envToken.length > 0) {
		return {
			providerId,
			token: envToken,
			credentialKind: parseDiscordCredentialKind(env.DISCORD_MCP_CREDENTIAL_KIND?.trim()),
			source: "env",
		};
	}
	const stored = loadStoredDiscordCredential(options, providerId);
	if (stored !== undefined) {
		return {
			providerId: stored.providerId,
			token: stored.payload.token,
			credentialKind: stored.payload.credentialKind,
			source: "stored",
		};
	}
	throw new Error("Discord credentials missing: set DISCORD_MCP_TOKEN or run `discord-mcp login`.");
}

export function resolveDiscordCredentialsPath(
	options: Pick<DiscordOperatorOptions, "credentialsPath" | "env"> = {},
): string {
	const env = options.env ?? process.env;
	const configured = options.credentialsPath ?? env.DISCORD_MCP_CREDENTIALS_PATH;
	if (configured !== undefined && configured.trim().length > 0) return expandHome(configured.trim());
	return join(homedir(), ".config", "discord-mcp", "credentials.json");
}

export function loadStoredDiscordCredential(
	options: Pick<DiscordOperatorOptions, "credentialsPath" | "env"> = {},
	providerId = resolveDiscordProviderId(options.env ?? process.env),
): DiscordStoredCredential | undefined {
	try {
		const raw = readFileSync(resolveDiscordCredentialsPath(options), "utf8");
		const parsed = JSON.parse(raw) as unknown;
		if (typeof parsed !== "object" || parsed === null) return undefined;
		const record = parsed as Record<string, unknown>;
		const item = record[providerId];
		if (typeof item !== "object" || item === null) return undefined;
		const payload = (item as Record<string, unknown>).payload;
		if (typeof payload !== "object" || payload === null) return undefined;
		const payloadRecord = payload as Record<string, unknown>;
		const token = typeof payloadRecord.token === "string" ? payloadRecord.token : undefined;
		if (token === undefined || token.trim().length === 0) return undefined;
		const credentialKind = parseDiscordCredentialKind(
			typeof payloadRecord.credentialKind === "string" ? payloadRecord.credentialKind : undefined,
		);
		const createdAt = typeof payloadRecord.createdAt === "string" ? payloadRecord.createdAt : new Date(0).toISOString();
		const updatedAt = typeof payloadRecord.updatedAt === "string" ? payloadRecord.updatedAt : new Date(0).toISOString();
		const identity = parseDiscordIdentity(payloadRecord.identity);
		return {
			providerId,
			payload: {
				token,
				credentialKind,
				...(identity === undefined ? {} : { identity }),
				createdAt,
				updatedAt,
			},
		};
	} catch (error) {
		if (isNotFoundError(error)) return undefined;
		throw error;
	}
}

export async function saveStoredDiscordCredential(
	payload: Omit<DiscordStoredCredentialPayload, "createdAt" | "updatedAt"> &
		Partial<Pick<DiscordStoredCredentialPayload, "createdAt" | "updatedAt">>,
	options: Pick<DiscordOperatorOptions, "credentialsPath" | "env"> = {},
	providerId = resolveDiscordProviderId(options.env ?? process.env),
): Promise<DiscordStoredCredential> {
	const path = resolveDiscordCredentialsPath(options);
	const existing = await readCredentialFile(path);
	const previous = existing[providerId] as DiscordStoredCredential | undefined;
	const now = new Date().toISOString();
	const stored: DiscordStoredCredential = {
		providerId,
		payload: {
			token: payload.token,
			credentialKind: payload.credentialKind,
			...(payload.identity === undefined ? {} : { identity: payload.identity }),
			createdAt: payload.createdAt ?? previous?.payload.createdAt ?? now,
			updatedAt: payload.updatedAt ?? now,
		},
	};
	existing[providerId] = stored;
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, JSON.stringify(existing, null, "\t"));
	return stored;
}

export async function removeStoredDiscordCredential(
	options: Pick<DiscordOperatorOptions, "credentialsPath" | "env"> = {},
	providerId = resolveDiscordProviderId(options.env ?? process.env),
): Promise<boolean> {
	const path = resolveDiscordCredentialsPath(options);
	const existing = await readCredentialFile(path);
	if (existing[providerId] === undefined) return false;
	delete existing[providerId];
	if (Object.keys(existing).length === 0) {
		await unlink(path).catch((error) => {
			if (!isNotFoundError(error)) throw error;
		});
		return true;
	}
	await writeFile(path, JSON.stringify(existing, null, "\t"));
	return true;
}

export async function getDiscordIdentity(options: DiscordOperatorOptions = {}): Promise<DiscordIdentity> {
	const json = await discordRequest("GET", "/users/@me", options);
	const record = expectRecord(json, "identity");
	return formatDiscordIdentity(record);
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
	const guildId = required(input.guild_id, "guild_id");
	const since = resolveOptionalTimeBoundary(input.since, "since");
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
	const channelId = required(input.channel_id, "channel_id");
	const limit = clampMessageLimit(input.limit ?? 20);
	const since = resolveOptionalTimeBoundary(input.since, "since");
	const until = resolveOptionalTimeBoundary(input.until, "until");
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
	const guildIdInput = input.guild_id;
	const guilds =
		guildIdInput === undefined || guildIdInput.trim().length === 0 ? await listDiscordGuilds(options) : undefined;
	const guildId =
		guildIdInput !== undefined && guildIdInput.trim().length > 0
			? guildIdInput.trim()
			: guilds?.length === 1
				? guilds[0]?.id
				: undefined;
	if (guildId === undefined) {
		throw new Error("discord_recent_activity requires guild_id unless exactly one visible guild is available.");
	}
	const guildName = guilds?.find((guild) => guild.id === guildId)?.name;
	const since =
		resolveOptionalTimeBoundary(input.since, "since") ?? parseTimeBoundary(DEFAULT_RECENT_ACTIVITY_SINCE, "since");
	const sinceTimestamp = since.toISOString();
	const limitChannels = clampPositiveInt(input.limit_channels, DEFAULT_RECENT_ACTIVITY_CHANNEL_LIMIT, 25);
	const messageLimit = clampMessageLimit(input.message_limit ?? DEFAULT_RECENT_ACTIVITY_MESSAGE_LIMIT);
	const includeMessages = input.include_messages ?? true;
	const requestedChannelIds = new Set(normalizeIdList(input.channel_ids));
	const channelNameQuery = normalizeQuery(input.channel_name_query);

	const channels = await listDiscordChannels(
		{
			guild_id: guildId,
			since: sinceTimestamp,
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
					channel_id: channel.id,
					limit: messageLimit,
					since: sinceTimestamp,
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

export async function recentDiscordAttachments(
	input: DiscordRecentAttachmentsInput,
	options: DiscordOperatorOptions = {},
): Promise<DiscordRecentAttachmentsResult> {
	const channelId = required(input.channel_id, "channel_id");
	const targetMessageId = trimToUndefined(input.message_id);
	const messageLimit = clampMessageLimit(
		input.message_limit ?? input.limit ?? DEFAULT_RECENT_ATTACHMENTS_MESSAGE_LIMIT,
	);
	const mediaLimit = clampPositiveInt(
		input.media_limit,
		DEFAULT_RECENT_ATTACHMENTS_MEDIA_LIMIT,
		MAX_RECENT_ATTACHMENTS_MEDIA_LIMIT,
	);
	const maxBytes = clampByteLimit(
		input.max_bytes,
		DEFAULT_RECENT_ATTACHMENTS_MAX_BYTES,
		MAX_RECENT_ATTACHMENTS_MAX_BYTES,
	);
	const maxVideoBytes = clampByteLimit(
		input.max_video_bytes,
		DEFAULT_RECENT_ATTACHMENTS_MAX_VIDEO_BYTES,
		MAX_RECENT_ATTACHMENTS_MAX_VIDEO_BYTES,
	);
	const around = input.around ?? targetMessageId;
	const loadImages = input.load_images ?? input.load ?? true;
	const includeVideoKeyframes = input.include_video_keyframes ?? true;
	const messages = await readDiscordMessages(
		{
			channel_id: channelId,
			limit: messageLimit,
			...(input.before === undefined ? {} : { before: input.before }),
			...(input.after === undefined ? {} : { after: input.after }),
			...(around === undefined ? {} : { around }),
			...(input.since === undefined ? {} : { since: input.since }),
			...(input.until === undefined ? {} : { until: input.until }),
		},
		options,
	);
	const targetMessage =
		targetMessageId === undefined ? undefined : messages.find((message) => message.id === targetMessageId);
	const scannedMessages = targetMessageId === undefined ? messages : targetMessage === undefined ? [] : [targetMessage];
	const media = collectRecentAttachmentMedia(scannedMessages, mediaLimit);
	const loadedImages: DiscordRecentAttachmentLoadedImageSummary[] = [];
	const imageContents: DiscordLoadedImageContent[] = [];
	const failures: DiscordRecentAttachmentFailure[] = [];

	if (loadImages) {
		for (const item of media) {
			try {
				const loaded = await loadRecentAttachmentImage(
					item,
					{ maxBytes, maxVideoBytes, includeVideoKeyframes },
					options,
				);
				if (loaded === undefined) {
					item.status = "metadata_only";
					item.statusReason =
						item.kind === "video" && !includeVideoKeyframes
							? "video keyframe loading disabled"
							: "media URL is not directly loadable as an image";
					continue;
				}
				imageContents.push(loaded.content);
				item.status = "loaded";
				if (loaded.generatedFromVideo) item.statusReason = "video keyframe extracted";
				loadedImages.push({
					imageIndex: imageContents.length,
					mediaIndex: item.mediaIndex,
					messageId: item.messageId,
					channelId: item.channelId,
					url: item.url,
					source: item.source,
					kind: item.kind,
					mimeType: loaded.content.mimeType,
					...(item.authorId === undefined ? {} : { authorId: item.authorId }),
					...(item.authorUsername === undefined ? {} : { authorUsername: item.authorUsername }),
					...(item.timestamp === undefined ? {} : { timestamp: item.timestamp }),
					...(loaded.generatedFromVideo ? { generatedFromVideo: true } : {}),
				});
			} catch (error) {
				const reason = error instanceof Error ? error.message : String(error);
				item.status = "failed";
				item.statusReason = reason;
				failures.push({
					mediaIndex: item.mediaIndex,
					messageId: item.messageId,
					url: item.url,
					reason,
				});
			}
		}
	}

	return {
		channelId,
		...(targetMessageId === undefined ? {} : { targetMessageId, targetMessageFound: targetMessage !== undefined }),
		generatedAt: new Date().toISOString(),
		scannedMessageCount: scannedMessages.length,
		mediaCount: media.length,
		loadedImageCount: imageContents.length,
		media,
		loadedImages,
		failures,
		imageContents,
	};
}

export async function sendDiscordMessage(
	input: DiscordSendMessageInput,
	options: DiscordOperatorOptions = {},
): Promise<DiscordSendMessageResult> {
	const channelId = required(input.channel_id, "channel_id");
	const content = input.content?.trim();
	const filePaths = input.file_paths ?? [];
	if ((content === undefined || content.length === 0) && filePaths.length === 0) {
		throw new Error("discord_send_message requires content or at least one file path.");
	}

	let body: BodyInit;
	let headers: Record<string, string> | undefined;
	const replyToMessageId = input.reply_to_message_id;
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
	const guildId = required(input.guild_id, "guild_id");
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
	const channelId = required(input.channel_id, "channel_id");
	const messageId = required(input.message_id, "message_id");
	const emoji = required(input.emoji, "emoji");
	await discordRequest(
		"PUT",
		`/channels/${encodeURIComponent(channelId)}/messages/${encodeURIComponent(messageId)}/reactions/${encodeURIComponent(emoji)}/@me`,
		options,
	);
	return { ok: true, channelId, messageId, emoji };
}

function collectRecentAttachmentMedia(
	messages: readonly DiscordMessageSummary[],
	mediaLimit: number,
): DiscordRecentAttachmentMediaResult[] {
	const results: DiscordRecentAttachmentMediaResult[] = [];
	const seen = new Set<string>();
	for (const message of messages.slice().sort(compareMessagesNewestFirst)) {
		for (const media of message.media) {
			const dedupeKey = `${message.id}:${media.url}`;
			if (seen.has(dedupeKey)) continue;
			seen.add(dedupeKey);
			results.push({
				...media,
				mediaIndex: results.length + 1,
				messageId: message.id,
				channelId: message.channelId,
				...(message.authorId === undefined ? {} : { authorId: message.authorId }),
				...(message.authorUsername === undefined ? {} : { authorUsername: message.authorUsername }),
				...(message.timestamp === undefined ? {} : { timestamp: message.timestamp }),
				status: "metadata_only",
			});
			if (results.length >= mediaLimit) return results;
		}
	}
	return results;
}

async function loadRecentAttachmentImage(
	media: DiscordRecentAttachmentMediaResult,
	limits: { maxBytes: number; maxVideoBytes: number; includeVideoKeyframes: boolean },
	options: DiscordOperatorOptions,
): Promise<{ content: DiscordLoadedImageContent; generatedFromVideo: boolean } | undefined> {
	if (media.kind === "image" || media.kind === "gif") {
		const content = await fetchDiscordMediaImage(media, limits.maxBytes, options);
		return { content, generatedFromVideo: false };
	}
	if (!limits.includeVideoKeyframes) return undefined;
	const content = await fetchDiscordVideoKeyframe(media, limits.maxVideoBytes, options);
	return { content, generatedFromVideo: true };
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

async function fetchDiscordMediaImage(
	media: DiscordRecentAttachmentMediaResult,
	maxBytes: number,
	options: DiscordOperatorOptions,
): Promise<DiscordLoadedImageContent> {
	const fetched = await fetchDiscordMediaBytes(media.url, maxBytes, options);
	const mimeType =
		normalizeImageMimeType(fetched.contentType) ??
		normalizeImageMimeType(media.contentType) ??
		inferImageMimeType(media.filename) ??
		inferImageMimeType(media.url);
	if (mimeType === undefined) throw new Error("response is not a supported image type");
	return {
		type: "image",
		data: fetched.bytes.toString("base64"),
		mimeType,
	};
}

async function fetchDiscordVideoKeyframe(
	media: DiscordRecentAttachmentMediaResult,
	maxBytes: number,
	options: DiscordOperatorOptions,
): Promise<DiscordLoadedImageContent> {
	const fetched = await fetchDiscordMediaBytes(media.url, maxBytes, options);
	const videoType =
		normalizeVideoMimeType(fetched.contentType) ??
		normalizeVideoMimeType(media.contentType) ??
		inferVideoMimeType(media.filename) ??
		inferVideoMimeType(media.url);
	if (videoType === undefined) throw new Error("response is not a supported video type");
	const tempDir = await mkdtemp(join(tmpdir(), "clanky-discord-media-"));
	try {
		const inputPath = join(tempDir, `source.${videoExtension(videoType)}`);
		const outputPath = join(tempDir, "frame.jpg");
		await writeFile(inputPath, fetched.bytes);
		try {
			await runFfmpeg(
				[
					"-hide_banner",
					"-loglevel",
					"error",
					"-y",
					"-ss",
					"00:00:01",
					"-i",
					inputPath,
					"-frames:v",
					"1",
					"-q:v",
					"3",
					outputPath,
				],
				options.signal,
			);
		} catch (error) {
			if (options.signal?.aborted === true) throw error;
			await runFfmpeg(
				["-hide_banner", "-loglevel", "error", "-y", "-i", inputPath, "-frames:v", "1", "-q:v", "3", outputPath],
				options.signal,
			);
		}
		const frame = await readFile(outputPath);
		return {
			type: "image",
			data: frame.toString("base64"),
			mimeType: "image/jpeg",
		};
	} finally {
		await rm(tempDir, { recursive: true, force: true });
	}
}

async function fetchDiscordMediaBytes(
	url: string,
	maxBytes: number,
	options: DiscordOperatorOptions,
): Promise<{ bytes: Buffer; contentType?: string }> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), DISCORD_MEDIA_FETCH_TIMEOUT_MS);
	timeout.unref?.();
	const onAbort = (): void => controller.abort();
	if (options.signal?.aborted === true) {
		controller.abort();
	} else {
		options.signal?.addEventListener("abort", onAbort, { once: true });
	}
	try {
		const response = await (options.fetchImpl ?? fetch)(url, { signal: controller.signal });
		if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
		const contentLength = response.headers.get("content-length");
		if (contentLength !== null) {
			const bytes = Number.parseInt(contentLength, 10);
			if (Number.isFinite(bytes) && bytes > maxBytes) {
				throw new Error(`media is ${bytes} bytes, limit is ${maxBytes}`);
			}
		}
		const bytes = Buffer.from(await response.arrayBuffer());
		if (bytes.byteLength > maxBytes) {
			throw new Error(`media is ${bytes.byteLength} bytes, limit is ${maxBytes}`);
		}
		const contentType = normalizeContentType(response.headers.get("content-type") ?? undefined);
		return {
			bytes,
			...(contentType === undefined ? {} : { contentType }),
		};
	} finally {
		options.signal?.removeEventListener("abort", onAbort);
		clearTimeout(timeout);
	}
}

function runFfmpeg(args: readonly string[], signal: AbortSignal | undefined): Promise<void> {
	return new Promise((resolve, reject) => {
		const child = spawn("ffmpeg", [...args], { stdio: ["ignore", "ignore", "pipe"] });
		let stderr = "";
		let timedOut = false;
		let aborted = false;
		let settled = false;
		const timeout = setTimeout(() => {
			timedOut = true;
			child.kill("SIGKILL");
		}, DISCORD_VIDEO_KEYFRAME_TIMEOUT_MS);
		timeout.unref?.();
		const finish = (error?: Error): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			signal?.removeEventListener("abort", onAbort);
			if (error === undefined) {
				resolve();
			} else {
				reject(error);
			}
		};
		const onAbort = (): void => {
			aborted = true;
			child.kill("SIGKILL");
		};
		if (signal?.aborted === true) {
			onAbort();
		} else {
			signal?.addEventListener("abort", onAbort, { once: true });
		}
		child.stderr?.on("data", (chunk: Buffer) => {
			stderr = `${stderr}${chunk.toString("utf8")}`;
			if (stderr.length > 2_000) stderr = stderr.slice(-2_000);
		});
		child.on("error", (error) => finish(error));
		child.on("close", (code) => {
			if (code === 0) {
				finish();
				return;
			}
			const reason = aborted
				? "ffmpeg aborted"
				: timedOut
					? "ffmpeg timed out"
					: `ffmpeg exited ${code ?? "unknown"}${stderr.trim().length > 0 ? `: ${stderr.trim()}` : ""}`;
			finish(new Error(reason));
		});
	});
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
	const response = await (options.fetchImpl ?? fetch)(`${DISCORD_API_BASE}${path}`, {
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

function parseDiscordCredentialKind(value: string | undefined): DiscordCredentialKind {
	return value === "user-token" ? "user-token" : "bot-token";
}

function resolveDiscordProviderId(env: NodeJS.ProcessEnv): string {
	return env.DISCORD_MCP_PROVIDER_ID?.trim() || DEFAULT_DISCORD_MCP_PROVIDER_ID;
}

async function readCredentialFile(path: string): Promise<Record<string, unknown>> {
	try {
		const raw = await readFile(path, "utf8");
		const parsed = JSON.parse(raw) as unknown;
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
		return parsed as Record<string, unknown>;
	} catch (error) {
		if (isNotFoundError(error)) return {};
		throw error;
	}
}

function parseDiscordIdentity(value: unknown): DiscordIdentity | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	const record = value as Record<string, unknown>;
	if (typeof record.id !== "string" || typeof record.username !== "string") return undefined;
	return {
		id: record.id,
		username: record.username,
		...(typeof record.globalName === "string" ? { globalName: record.globalName } : {}),
		...(typeof record.bot === "boolean" ? { bot: record.bot } : {}),
	};
}

function formatDiscordIdentity(record: Record<string, unknown>): DiscordIdentity {
	return {
		id: expectString(record.id, "identity.id"),
		username: expectString(record.username, "identity.username"),
		...(typeof record.global_name === "string" ? { globalName: record.global_name } : {}),
		...(typeof record.bot === "boolean" ? { bot: record.bot } : {}),
	};
}

function expandHome(path: string): string {
	if (path === "~") return homedir();
	if (path.startsWith("~/")) return join(homedir(), path.slice(2));
	return path;
}

function isNotFoundError(error: unknown): boolean {
	return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "ENOENT";
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
	const attachmentSummaries = attachments.flatMap(formatDiscordMessageAttachment);
	const content = typeof record.content === "string" ? record.content : "";
	const media = dedupeDiscordMessageMedia([
		...attachmentSummaries.flatMap(formatDiscordAttachmentMedia),
		...formatDiscordEmbedMedia(record.embeds),
		...formatDiscordContentLinkMedia(content),
	]);
	return {
		id: expectString(record.id, "message.id"),
		channelId: expectString(record.channel_id, "message.channel_id"),
		content,
		attachments: attachmentSummaries,
		attachmentUrls: attachmentSummaries.flatMap((attachment) => (attachment.url === undefined ? [] : [attachment.url])),
		media,
		mediaUrls: media.map((entry) => entry.url),
		...(author !== undefined && typeof author.id === "string" ? { authorId: author.id } : {}),
		...(author !== undefined && typeof author.username === "string" ? { authorUsername: author.username } : {}),
		...(typeof record.timestamp === "string" ? { timestamp: record.timestamp } : {}),
	};
}

function formatDiscordMessageAttachment(item: unknown): DiscordMessageAttachmentSummary[] {
	if (typeof item !== "object" || item === null) return [];
	const record = item as Record<string, unknown>;
	const attachment: DiscordMessageAttachmentSummary = {};
	if (typeof record.id === "string") attachment.id = record.id;
	if (typeof record.url === "string") attachment.url = record.url;
	if (typeof record.filename === "string") attachment.filename = record.filename;
	if (typeof record.content_type === "string") attachment.contentType = record.content_type;
	if (typeof record.size === "number") attachment.size = record.size;
	return [attachment];
}

function formatDiscordAttachmentMedia(attachment: DiscordMessageAttachmentSummary): DiscordMessageMediaSummary[] {
	const url = normalizeHttpUrl(attachment.url);
	if (url === undefined) return [];
	const kind = classifyMediaKind(attachment.contentType, attachment.filename, url);
	if (kind === undefined) return [];
	const contentType = normalizeContentType(attachment.contentType);
	const media: DiscordMessageMediaSummary = { kind, source: "attachment", url };
	if (attachment.filename !== undefined) media.filename = attachment.filename;
	if (contentType !== undefined) media.contentType = contentType;
	if (attachment.size !== undefined) media.size = attachment.size;
	return [media];
}

function formatDiscordEmbedMedia(value: unknown): DiscordMessageMediaSummary[] {
	if (!Array.isArray(value)) return [];
	return value.flatMap((item) => {
		if (typeof item !== "object" || item === null) return [];
		const record = item as Record<string, unknown>;
		const embedType = typeof record.type === "string" ? record.type : undefined;
		const providerName =
			typeof record.provider === "object" && record.provider !== null
				? normalizeString((record.provider as Record<string, unknown>).name)
				: undefined;
		const title = normalizeString(record.title);
		const base = {
			...(embedType === undefined ? {} : { embedType }),
			...(providerName === undefined ? {} : { providerName }),
			...(title === undefined ? {} : { title }),
		};
		return dedupeDiscordMessageMedia([
			...formatDiscordEmbedAsset(record.image, "image", base),
			...formatDiscordEmbedAsset(record.thumbnail, "thumbnail", base),
			...formatDiscordEmbedAsset(record.video, "video", base),
			...formatDiscordEmbedUrl(record.url, base),
		]);
	});
}

function formatDiscordEmbedAsset(
	value: unknown,
	sourceDetail: string,
	base: Pick<DiscordMessageMediaSummary, "embedType" | "providerName" | "title">,
): DiscordMessageMediaSummary[] {
	if (typeof value !== "object" || value === null) return [];
	const record = value as Record<string, unknown>;
	const originalUrl = normalizeHttpUrl(normalizeString(record.url));
	const proxyUrl = normalizeHttpUrl(normalizeString(record.proxy_url));
	const url = proxyUrl ?? originalUrl;
	if (url === undefined) return [];
	const contentType = normalizeContentType(normalizeString(record.content_type));
	const kind =
		sourceDetail === "video"
			? "video"
			: (classifyMediaKind(contentType, undefined, url) ?? (base.embedType === "gifv" ? "gif" : "image"));
	return [
		{
			kind,
			source: "embed",
			url,
			sourceDetail,
			...base,
			...(originalUrl === undefined ? {} : { originalUrl }),
			...(proxyUrl === undefined ? {} : { proxyUrl }),
			...(contentType === undefined ? {} : { contentType }),
			...(typeof record.width === "number" ? { width: record.width } : {}),
			...(typeof record.height === "number" ? { height: record.height } : {}),
		},
	];
}

function formatDiscordEmbedUrl(
	value: unknown,
	base: Pick<DiscordMessageMediaSummary, "embedType" | "providerName" | "title">,
): DiscordMessageMediaSummary[] {
	const url = normalizeHttpUrl(normalizeString(value));
	if (url === undefined) return [];
	const kind = classifyMediaKind(undefined, undefined, url);
	if (kind === undefined) return [];
	return [
		{
			kind,
			source: "embed",
			url,
			sourceDetail: "url",
			...base,
		},
	];
}

function formatDiscordContentLinkMedia(content: string): DiscordMessageMediaSummary[] {
	return extractHttpUrls(content).flatMap((url) => {
		const kind = classifyMediaKind(undefined, undefined, url);
		if (kind === undefined) return [];
		return [{ kind, source: "link", url }];
	});
}

function dedupeDiscordMessageMedia(media: readonly DiscordMessageMediaSummary[]): DiscordMessageMediaSummary[] {
	const seen = new Set<string>();
	const results: DiscordMessageMediaSummary[] = [];
	for (const item of media) {
		if (seen.has(item.url)) continue;
		seen.add(item.url);
		results.push(item);
	}
	return results;
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

function normalizeString(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed.length === 0 ? undefined : trimmed;
}

function normalizeHttpUrl(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	if (trimmed === undefined || trimmed.length === 0) return undefined;
	try {
		const parsed = new URL(trimmed);
		if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return undefined;
		return parsed.toString();
	} catch {
		return undefined;
	}
}

function extractHttpUrls(text: string): string[] {
	const matches = text.matchAll(/https?:\/\/[^\s<>"`]+/giu);
	return [...matches].flatMap((match) => {
		const raw = match[0]?.replace(/[),.;!?]+$/u, "");
		const url = normalizeHttpUrl(raw);
		return url === undefined ? [] : [url];
	});
}

function normalizeContentType(value: string | undefined): string | undefined {
	const type = value?.split(";")[0]?.trim().toLowerCase();
	return type === undefined || type.length === 0 ? undefined : type;
}

function normalizeImageMimeType(value: string | undefined): string | undefined {
	const type = normalizeContentType(value);
	if (type === "image/png" || type === "image/jpeg" || type === "image/webp" || type === "image/gif") return type;
	return undefined;
}

function normalizeVideoMimeType(value: string | undefined): string | undefined {
	const type = normalizeContentType(value);
	if (type === "video/mp4" || type === "video/webm" || type === "video/quicktime") return type;
	return undefined;
}

function classifyMediaKind(
	contentType: string | undefined,
	filename: string | undefined,
	url: string | undefined,
): DiscordMessageMediaKind | undefined {
	const normalized = normalizeContentType(contentType);
	if (normalized === "image/gif") return "gif";
	if (normalized?.startsWith("image/") === true)
		return normalizeImageMimeType(normalized) === undefined ? undefined : "image";
	if (normalized?.startsWith("video/") === true)
		return normalizeVideoMimeType(normalized) === undefined ? undefined : "video";
	const imageMimeType = inferImageMimeType(filename) ?? inferImageMimeType(url);
	if (imageMimeType === "image/gif") return "gif";
	if (imageMimeType !== undefined) return "image";
	if ((inferVideoMimeType(filename) ?? inferVideoMimeType(url)) !== undefined) return "video";
	return undefined;
}

function inferImageMimeType(value: string | undefined): string | undefined {
	const lower = normalizedUrlPath(value);
	if (lower === undefined) return undefined;
	if (lower.endsWith(".png")) return "image/png";
	if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
	if (lower.endsWith(".webp")) return "image/webp";
	if (lower.endsWith(".gif")) return "image/gif";
	return undefined;
}

function inferVideoMimeType(value: string | undefined): string | undefined {
	const lower = normalizedUrlPath(value);
	if (lower === undefined) return undefined;
	if (lower.endsWith(".mp4")) return "video/mp4";
	if (lower.endsWith(".webm")) return "video/webm";
	if (lower.endsWith(".mov")) return "video/quicktime";
	return undefined;
}

function normalizedUrlPath(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	if (trimmed === undefined || trimmed.length === 0) return undefined;
	let path = trimmed;
	try {
		path = new URL(trimmed).pathname;
	} catch {
		path = trimmed;
	}
	try {
		return decodeURIComponent(path).toLowerCase();
	} catch {
		return path.toLowerCase();
	}
}

function videoExtension(mimeType: string): string {
	if (mimeType === "video/webm") return "webm";
	if (mimeType === "video/quicktime") return "mov";
	return "mp4";
}

function clampByteLimit(value: number | undefined, fallback: number, maximum: number): number {
	if (value === undefined || !Number.isFinite(value)) return fallback;
	return Math.max(1, Math.min(maximum, Math.floor(value)));
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

const RELATIVE_DURATION_UNIT_MS: Record<"ms" | "s" | "m" | "h" | "d" | "w", number> = {
	ms: 1,
	s: 1_000,
	m: 60_000,
	h: 3_600_000,
	d: 86_400_000,
	w: 604_800_000,
};

function parseRelativeDurationMs(value: string): number | undefined {
	const match = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d|w)$/i.exec(value.trim());
	const rawAmount = match?.[1];
	const rawUnit = match?.[2];
	if (rawAmount === undefined || rawUnit === undefined) return undefined;
	const amount = Number.parseFloat(rawAmount);
	if (!Number.isFinite(amount) || amount < 0) return undefined;
	const unit = rawUnit.toLowerCase() as keyof typeof RELATIVE_DURATION_UNIT_MS;
	return amount * RELATIVE_DURATION_UNIT_MS[unit];
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
