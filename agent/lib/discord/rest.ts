import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import {
	DiscordAPIError,
	HTTPError,
	REST,
	RequestMethod,
	type InternalRequest,
	type RESTOptions,
	type RawFile,
	type RouteLike,
} from "discord.js";
import { type DiscordCredentialKind, chunkDiscordMessage, resolveDiscordCredentialKind, resolveDiscordToken } from "./gateway.ts";

const DISCORD_EPOCH_MS = 1_420_070_400_000n;
const TEXT_CHANNEL_TYPES = new Set([0, 5, 10, 11, 12]);
const DEFAULT_RECENT_ACTIVITY_SINCE = "7d";
/** Retries for 5xx/network failures inside discord.js's REST handler. */
const DISCORD_REST_RETRIES = 3;
/** Parallel per-channel message fetches in discordRecentActivity. */
const RECENT_ACTIVITY_FETCH_CONCURRENCY = 5;

export interface DiscordRestOptions {
	env?: NodeJS.ProcessEnv;
	fetchImpl?: typeof fetch;
}

export interface DiscordGuildSummary {
	id: string;
	name: string;
	owner?: boolean;
}

export interface DiscordIdentitySummary {
	id: string;
	username: string;
	globalName?: string;
	bot?: boolean;
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
	content: string;
	authorId?: string;
	authorUsername?: string;
	timestamp?: string;
	attachments: DiscordAttachmentSummary[];
	embeds: DiscordEmbedSummary[];
	links: string[];
	media: DiscordMediaSummary[];
}

export interface DiscordAttachmentSummary {
	id?: string;
	url?: string;
	filename?: string;
	contentType?: string;
	size?: number;
	width?: number;
	height?: number;
}

export interface DiscordEmbedSummary {
	type?: string;
	url?: string;
	title?: string;
	description?: string;
	provider?: string;
	imageUrl?: string;
	imageProxyUrl?: string;
	imageContentType?: string;
	imageWidth?: number;
	imageHeight?: number;
	thumbnailUrl?: string;
	thumbnailProxyUrl?: string;
	thumbnailContentType?: string;
	thumbnailWidth?: number;
	thumbnailHeight?: number;
	videoUrl?: string;
	videoProxyUrl?: string;
	videoContentType?: string;
	videoWidth?: number;
	videoHeight?: number;
}

export interface DiscordMediaSummary {
	kind: "image" | "gif" | "video" | "link";
	source: "attachment" | "embed" | "content";
	url: string;
	originalUrl?: string;
	proxyUrl?: string;
	contentType?: string;
	filename?: string;
	size?: number;
	width?: number;
	height?: number;
	title?: string;
	provider?: string;
	sourceDetail?: string;
	embedType?: string;
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

export interface DiscordRecentActivityChannel extends DiscordChannelSummary {
	messageCount: number;
	topParticipants: DiscordParticipantSummary[];
	messages: DiscordMessageSummary[];
}

export interface DiscordRecentActivityFailedChannel {
	channelId: string;
	name?: string;
	error: string;
}

export async function discordWhoami(options: DiscordRestOptions = {}): Promise<DiscordIdentitySummary> {
	const json = await discordRequest("GET", "/users/@me", undefined, options);
	if (!isRecord(json) || typeof json.id !== "string" || typeof json.username !== "string") {
		throw new Error("Discord identity response did not include id and username");
	}
	return {
		id: json.id,
		username: json.username,
		...(typeof json.global_name === "string" ? { globalName: json.global_name } : {}),
		...(typeof json.bot === "boolean" ? { bot: json.bot } : {}),
	};
}

export async function discordListGuilds(options: DiscordRestOptions = {}): Promise<DiscordGuildSummary[]> {
	const json = await discordRequest("GET", "/users/@me/guilds", undefined, options);
	if (!Array.isArray(json)) throw new Error("Discord guild list response was not an array");
	return json.flatMap((item) => {
		if (!isRecord(item) || typeof item.id !== "string" || typeof item.name !== "string") return [];
		return [{ id: item.id, name: item.name, ...(typeof item.owner === "boolean" ? { owner: item.owner } : {}) }];
	});
}

export async function discordListChannels(
	input: string | { guildId: string; since?: string },
	options: DiscordRestOptions = {},
): Promise<DiscordChannelSummary[]> {
	const guildId = typeof input === "string" ? input : input.guildId;
	const since = typeof input === "string" ? undefined : resolveOptionalTimeBoundary(input.since, "since");
	const json = await discordRequest("GET", `/guilds/${encodeURIComponent(guildId)}/channels`, undefined, options);
	if (!Array.isArray(json)) throw new Error("Discord channel list response was not an array");
	const channels = json.flatMap(formatChannel);
	const filtered =
		since === undefined
			? channels
			: channels.filter((channel) => {
					if (channel.lastMessageAt === undefined) return false;
					const timestamp = Date.parse(channel.lastMessageAt);
					return Number.isFinite(timestamp) && timestamp >= since.getTime();
				});
	return filtered.sort((left, right) => (left.name ?? left.id).localeCompare(right.name ?? right.id));
}

export async function discordReadMessages(
	input: { channelId: string; limit?: number; before?: string; after?: string; around?: string; since?: string; until?: string },
	options: DiscordRestOptions = {},
): Promise<DiscordMessageSummary[]> {
	const limit = Math.max(1, Math.min(100, Math.floor(input.limit ?? 25)));
	const since = resolveOptionalTimeBoundary(input.since, "since");
	const until = resolveOptionalTimeBoundary(input.until, "until");
	if (since !== undefined || until !== undefined) {
		return await readDiscordMessagesWithinWindow(
			{
				channelId: input.channelId,
				limit,
				...(input.before === undefined ? {} : { before: input.before }),
				...(input.after === undefined ? {} : { after: input.after }),
			},
			options,
			since,
			until,
		);
	}
	const params = new URLSearchParams();
	params.set("limit", String(limit));
	if (input.before !== undefined) params.set("before", input.before);
	if (input.after !== undefined) params.set("after", input.after);
	if (input.around !== undefined) params.set("around", input.around);
	const json = await discordRequest("GET", `/channels/${encodeURIComponent(input.channelId)}/messages`, undefined, options, {
		query: params,
	});
	if (!Array.isArray(json)) throw new Error("Discord messages response was not an array");
	return json.flatMap(formatMessage);
}

export async function discordListEmojis(guildId: string, options: DiscordRestOptions = {}): Promise<DiscordEmojiSummary[]> {
	const json = await discordRequest("GET", `/guilds/${encodeURIComponent(guildId)}/emojis`, undefined, options);
	if (!Array.isArray(json)) throw new Error("Discord emoji list response was not an array");
	return json.flatMap((item) => {
		if (!isRecord(item) || typeof item.id !== "string" || typeof item.name !== "string") return [];
		const animated = typeof item.animated === "boolean" ? item.animated : false;
		return [{ id: item.id, name: item.name, animated, reaction: `${animated ? "a:" : ""}${item.name}:${item.id}` }];
	});
}

export async function discordAddReaction(
	input: { channelId: string; messageId: string; emoji: string },
	options: DiscordRestOptions = {},
): Promise<{ ok: true; channelId: string; messageId: string; emoji: string }> {
	if (input.emoji.trim().length === 0) throw new Error("discord_add_reaction requires an emoji");
	await discordRequest(
		"PUT",
		`/channels/${encodeURIComponent(input.channelId)}/messages/${encodeURIComponent(input.messageId)}/reactions/${encodeURIComponent(input.emoji.trim())}/@me`,
		undefined,
		options,
	);
	return { ok: true, channelId: input.channelId, messageId: input.messageId, emoji: input.emoji.trim() };
}

export async function discordRecentActivity(
	input: {
		guildId: string;
		since?: string;
		channelIds?: string[];
		channelNameQuery?: string;
		channelLimit?: number;
		messageLimit?: number;
		includeMessages?: boolean;
	},
	options: DiscordRestOptions = {},
): Promise<{
	guildId: string;
	sinceTimestamp: string;
	generatedAt: string;
	activeChannelCount: number;
	channels: DiscordRecentActivityChannel[];
	failedChannels: DiscordRecentActivityFailedChannel[];
}> {
	const since = resolveOptionalTimeBoundary(input.since, "since") ?? parseTimeBoundary(DEFAULT_RECENT_ACTIVITY_SINCE, "since");
	const sinceTimestamp = since.toISOString();
	const requestedChannelIds = new Set((input.channelIds ?? []).map((value) => value.trim()).filter((value) => value.length > 0));
	const channelNameQuery = normalizeQuery(input.channelNameQuery);
	const matchingChannels = (await discordListChannels({ guildId: input.guildId, since: sinceTimestamp }, options))
		.filter((channel) => TEXT_CHANNEL_TYPES.has(channel.type))
		.filter((channel) => requestedChannelIds.size === 0 || requestedChannelIds.has(channel.id))
		.filter((channel) => channelNameQuery === undefined || normalizeQuery(channel.name)?.includes(channelNameQuery) === true)
		.sort((left, right) => compareSnowflakes(right.lastMessageId, left.lastMessageId));
	const channels = matchingChannels.slice(0, Math.max(1, Math.min(20, Math.floor(input.channelLimit ?? 5))));
	const includeMessages = input.includeMessages !== false;
	const failedChannels: DiscordRecentActivityFailedChannel[] = [];
	const withMessages = await mapWithConcurrency(channels, RECENT_ACTIVITY_FETCH_CONCURRENCY, async (channel) => {
		try {
			const messages = await discordReadMessages(
				{ channelId: channel.id, limit: input.messageLimit ?? 10, since: sinceTimestamp },
				options,
			);
			return {
				...channel,
				messageCount: messages.length,
				topParticipants: summarizeParticipants(messages),
				messages: includeMessages ? messages : [],
			};
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			console.error(
				`discord recent activity read failed channel=${channel.id}${channel.name === undefined ? "" : ` (#${channel.name})`}: ${detail}`,
			);
			failedChannels.push({
				channelId: channel.id,
				...(channel.name === undefined ? {} : { name: channel.name }),
				error: detail,
			});
			return null;
		}
	});
	return {
		guildId: input.guildId,
		sinceTimestamp,
		generatedAt: new Date().toISOString(),
		activeChannelCount: matchingChannels.length,
		channels: withMessages.filter((channel) => channel !== null),
		failedChannels,
	};
}

/** Run tasks over items with a bounded worker pool, preserving result order. */
async function mapWithConcurrency<Item, Result>(
	items: readonly Item[],
	concurrency: number,
	task: (item: Item) => Promise<Result>,
): Promise<Result[]> {
	const results = new Array<Result>(items.length);
	let nextIndex = 0;
	const workers = Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, async () => {
		while (nextIndex < items.length) {
			const index = nextIndex;
			nextIndex += 1;
			results[index] = await task(items[index] as Item);
		}
	});
	await Promise.all(workers);
	return results;
}

export async function discordSendMessage(
	input: { channelId: string; content?: string; filePaths?: string[]; replyToMessageId?: string },
	options: DiscordRestOptions = {},
): Promise<{ ok: true; messageIds: string[]; attachmentCount: number }> {
	const content = input.content?.trim() ?? "";
	const filePaths = (input.filePaths ?? []).map((path) => path.trim()).filter((path) => path.length > 0);
	if (content.length === 0 && filePaths.length === 0) throw new Error("discord_send_message requires content or file paths");
	const messageIds: string[] = [];
	const messagesPath: RouteLike = `/channels/${encodeURIComponent(input.channelId)}/messages`;
	const chunks = content.length === 0 ? [] : chunkDiscordMessage(content);
	// The reply reference attaches to the first message only.
	let replyToMessageId = input.replyToMessageId;
	if (filePaths.length === 0) {
		for (const chunk of chunks) {
			const body: Record<string, unknown> = { content: chunk, allowed_mentions: { parse: [] } };
			if (replyToMessageId !== undefined) {
				body.message_reference = { message_id: replyToMessageId };
				replyToMessageId = undefined;
			}
			const sent = await discordRequest("POST", messagesPath, body, options);
			if (isRecord(sent) && typeof sent.id === "string") messageIds.push(sent.id);
		}
		return { ok: true, messageIds, attachmentCount: 0 };
	}
	// With files: post any leading content chunks as plain messages, then attach
	// the files to a final multipart message carrying the last chunk, so content
	// over the 2000-char limit is never rejected alongside an upload.
	const leadingChunks = chunks.length > 1 ? chunks.slice(0, -1) : [];
	const finalContent = chunks.length > 0 ? chunks[chunks.length - 1] ?? "" : "";
	for (const chunk of leadingChunks) {
		const body: Record<string, unknown> = { content: chunk, allowed_mentions: { parse: [] } };
		if (replyToMessageId !== undefined) {
			body.message_reference = { message_id: replyToMessageId };
			replyToMessageId = undefined;
		}
		const sent = await discordRequest("POST", messagesPath, body, options);
		if (isRecord(sent) && typeof sent.id === "string") messageIds.push(sent.id);
	}
	const payload: Record<string, unknown> = { content: finalContent, allowed_mentions: { parse: [] } };
	if (replyToMessageId !== undefined) payload.message_reference = { message_id: replyToMessageId };
	// discord.js's REST builds the multipart body itself: payload as payload_json,
	// each file appended as files[<index>].
	const files: RawFile[] = [];
	for (const path of filePaths) {
		files.push({ name: basename(path), data: await readFile(path) });
	}
	const sent = await discordRequest("POST", messagesPath, payload, options, { files });
	if (isRecord(sent) && typeof sent.id === "string") messageIds.push(sent.id);
	return { ok: true, messageIds, attachmentCount: filePaths.length };
}

const REQUEST_METHODS: Record<"GET" | "POST" | "PUT", RequestMethod> = {
	GET: RequestMethod.Get,
	POST: RequestMethod.Post,
	PUT: RequestMethod.Put,
};

/** Rate-limit-aware REST clients from discord.js, cached per credential so
 * per-route buckets and Retry-After state are shared across calls. */
const discordRestClients = new Map<string, REST>();

function buildDiscordRestClient(token: string, credentialKind: DiscordCredentialKind, fetchImpl: typeof fetch | undefined): REST {
	const rest = new REST({
		version: "10",
		retries: DISCORD_REST_RETRIES,
		...(fetchImpl === undefined
			? {}
			: {
					makeRequest: (async (url, init) =>
						fetchImpl(url, init as globalThis.RequestInit)) as RESTOptions["makeRequest"],
				}),
	});
	// User/self tokens carry no "Bot " prefix; those requests set auth headers
	// themselves (auth: false), so the token is only registered for bot mode.
	if (credentialKind === "bot-token") rest.setToken(token);
	rest.on("rateLimited", (info) => {
		console.warn(
			`discord REST rate limited: route=${info.route} method=${info.method} timeToReset=${Math.round(info.timeToReset)}ms global=${info.global}`,
		);
	});
	return rest;
}

function resolveDiscordRestClient(token: string, credentialKind: DiscordCredentialKind, fetchImpl: typeof fetch | undefined): REST {
	// Injected fetch (offline tests) gets a fresh client so doubles never share state.
	if (fetchImpl !== undefined) return buildDiscordRestClient(token, credentialKind, fetchImpl);
	const key = `${credentialKind}:${token}`;
	const existing = discordRestClients.get(key);
	if (existing !== undefined) return existing;
	const created = buildDiscordRestClient(token, credentialKind, undefined);
	discordRestClients.set(key, created);
	return created;
}

/**
 * One Discord REST call routed through discord.js's rate-limit-aware REST
 * manager: 429s wait out Retry-After (per-route and global buckets), 5xx and
 * network failures retry up to DISCORD_REST_RETRIES. The raw response is parsed
 * here to keep this module's lenient parse-any-body-as-JSON contract.
 */
async function discordRequest(
	method: "GET" | "POST" | "PUT",
	path: RouteLike,
	body: unknown,
	options: DiscordRestOptions,
	extra: { query?: URLSearchParams; files?: RawFile[] } = {},
): Promise<unknown> {
	const env = options.env ?? process.env;
	const token = resolveDiscordToken(env);
	if (token === undefined) throw new Error("Discord token missing: set DISCORD_BOT_TOKEN or CLANKY_DISCORD_TOKEN");
	const credentialKind = resolveDiscordCredentialKind(env);
	const rest = resolveDiscordRestClient(token, credentialKind, options.fetchImpl);
	const request: InternalRequest = {
		fullRoute: path,
		method: REQUEST_METHODS[method],
		...(body === undefined ? {} : { body }),
		...(extra.query === undefined ? {} : { query: extra.query }),
		...(extra.files === undefined ? {} : { files: extra.files }),
		...(credentialKind === "user-token" ? { auth: false, headers: { authorization: token } } : {}),
	};
	const response = await rest.queueRequest(request).catch((error: unknown): never => {
		if (error instanceof DiscordAPIError || error instanceof HTTPError) {
			// A 401 makes discord.js drop its cached token; evict the client so the
			// next call re-resolves credentials instead of failing forever.
			if (error.status === 401 && options.fetchImpl === undefined) {
				discordRestClients.delete(`${credentialKind}:${token}`);
			}
			throw new Error(`Discord API ${method} ${path} failed (${error.status}): ${error.message}`, { cause: error });
		}
		throw error;
	});
	const text = await response.text();
	if (text.length === 0) return {};
	try {
		return JSON.parse(text) as unknown;
	} catch {
		throw new Error(`Discord API ${method} ${path} returned a non-JSON body (${response.status})`);
	}
}

function formatChannel(item: unknown): DiscordChannelSummary[] {
	if (!isRecord(item) || typeof item.id !== "string" || typeof item.type !== "number") return [];
	const lastMessageId = typeof item.last_message_id === "string" ? item.last_message_id : undefined;
	return [
		{
			id: item.id,
			type: item.type,
			...(typeof item.name === "string" ? { name: item.name } : {}),
			...(typeof item.guild_id === "string" ? { guildId: item.guild_id } : {}),
			...(typeof item.parent_id === "string" ? { parentId: item.parent_id } : {}),
			...(lastMessageId === undefined ? {} : { lastMessageId, lastMessageAt: snowflakeTimestamp(lastMessageId) }),
		},
	];
}

function formatMessage(item: unknown): DiscordMessageSummary[] {
	if (!isRecord(item) || typeof item.id !== "string" || typeof item.channel_id !== "string") return [];
	const author = isRecord(item.author) ? item.author : {};
	const attachments = Array.isArray(item.attachments) ? item.attachments.flatMap(formatAttachment) : [];
	const embeds = Array.isArray(item.embeds) ? item.embeds.flatMap(formatEmbed) : [];
	const content = typeof item.content === "string" ? item.content : "";
	const links = extractHttpUrls(content);
	const media = collectMedia(content, attachments, embeds);
	return [
		{
			id: item.id,
			channelId: item.channel_id,
			content,
			attachments,
			embeds,
			links,
			media,
			...(typeof author.id === "string" ? { authorId: author.id } : {}),
			...(typeof author.username === "string" ? { authorUsername: author.username } : {}),
			...(typeof item.timestamp === "string" ? { timestamp: item.timestamp } : {}),
		},
	];
}

function formatAttachment(item: unknown): DiscordAttachmentSummary[] {
	if (!isRecord(item)) return [];
	return [
		{
			...(typeof item.id === "string" ? { id: item.id } : {}),
			...(typeof item.url === "string" ? { url: item.url } : {}),
			...(typeof item.filename === "string" ? { filename: item.filename } : {}),
			...(typeof item.content_type === "string" ? { contentType: item.content_type } : {}),
			...(typeof item.size === "number" ? { size: item.size } : {}),
			...(typeof item.width === "number" ? { width: item.width } : {}),
			...(typeof item.height === "number" ? { height: item.height } : {}),
		},
	];
}

function formatEmbed(item: unknown): DiscordEmbedSummary[] {
	if (!isRecord(item)) return [];
	const image = formatEmbedAsset(item.image);
	const thumbnail = formatEmbedAsset(item.thumbnail);
	const video = formatEmbedAsset(item.video);
	const provider = isRecord(item.provider) && typeof item.provider.name === "string" ? item.provider.name : undefined;
	return [
		{
			...(typeof item.type === "string" ? { type: item.type } : {}),
			...(typeof item.url === "string" ? { url: item.url } : {}),
			...(typeof item.title === "string" ? { title: item.title } : {}),
			...(typeof item.description === "string" ? { description: item.description } : {}),
			...(provider === undefined ? {} : { provider }),
			...(image.url === undefined ? {} : { imageUrl: image.url }),
			...(image.proxyUrl === undefined ? {} : { imageProxyUrl: image.proxyUrl }),
			...(image.contentType === undefined ? {} : { imageContentType: image.contentType }),
			...(image.width === undefined ? {} : { imageWidth: image.width }),
			...(image.height === undefined ? {} : { imageHeight: image.height }),
			...(thumbnail.url === undefined ? {} : { thumbnailUrl: thumbnail.url }),
			...(thumbnail.proxyUrl === undefined ? {} : { thumbnailProxyUrl: thumbnail.proxyUrl }),
			...(thumbnail.contentType === undefined ? {} : { thumbnailContentType: thumbnail.contentType }),
			...(thumbnail.width === undefined ? {} : { thumbnailWidth: thumbnail.width }),
			...(thumbnail.height === undefined ? {} : { thumbnailHeight: thumbnail.height }),
			...(video.url === undefined ? {} : { videoUrl: video.url }),
			...(video.proxyUrl === undefined ? {} : { videoProxyUrl: video.proxyUrl }),
			...(video.contentType === undefined ? {} : { videoContentType: video.contentType }),
			...(video.width === undefined ? {} : { videoWidth: video.width }),
			...(video.height === undefined ? {} : { videoHeight: video.height }),
		},
	];
}

function collectMedia(content: string, attachments: readonly DiscordAttachmentSummary[], embeds: readonly DiscordEmbedSummary[]): DiscordMediaSummary[] {
	const out: DiscordMediaSummary[] = [];
	for (const attachment of attachments) {
		if (attachment.url === undefined) continue;
		const kind = mediaKind(attachment.url, attachment.contentType);
		if (kind !== undefined) {
			out.push({
				kind,
				source: "attachment",
				url: attachment.url,
				sourceDetail: "attachment",
				...(attachment.contentType === undefined ? {} : { contentType: attachment.contentType }),
				...(attachment.filename === undefined ? {} : { filename: attachment.filename }),
				...(attachment.size === undefined ? {} : { size: attachment.size }),
				...(attachment.width === undefined ? {} : { width: attachment.width }),
				...(attachment.height === undefined ? {} : { height: attachment.height }),
			});
		}
	}
	for (const embed of embeds) {
		out.push(...collectEmbedMedia(embed));
	}
	for (const url of extractHttpUrls(content)) {
		out.push({ kind: mediaKind(url, undefined) ?? "link", source: "content", url, sourceDetail: "content" });
	}
	return out.filter((entry, index, all) => all.findIndex((candidate) => candidate.url === entry.url) === index);
}

function collectEmbedMedia(embed: DiscordEmbedSummary): DiscordMediaSummary[] {
	const base = {
		...(embed.title === undefined ? {} : { title: embed.title }),
		...(embed.provider === undefined ? {} : { provider: embed.provider }),
		...(embed.type === undefined ? {} : { embedType: embed.type }),
	};
	return [
		...embedAssetMedia(embed.imageUrl, embed.imageProxyUrl, "image", embed.imageContentType, embed.imageWidth, embed.imageHeight, base),
		...embedAssetMedia(
			embed.thumbnailUrl,
			embed.thumbnailProxyUrl,
			"thumbnail",
			embed.thumbnailContentType,
			embed.thumbnailWidth,
			embed.thumbnailHeight,
			base,
		),
		...embedAssetMedia(embed.videoUrl, embed.videoProxyUrl, "video", embed.videoContentType, embed.videoWidth, embed.videoHeight, base),
		...embedUrlMedia(embed.url, base),
	];
}

function embedAssetMedia(
	originalUrl: string | undefined,
	proxyUrl: string | undefined,
	sourceDetail: string,
	contentType: string | undefined,
	width: number | undefined,
	height: number | undefined,
	base: Pick<DiscordMediaSummary, "title" | "provider" | "embedType">,
): DiscordMediaSummary[] {
	const url = proxyUrl ?? originalUrl;
	if (url === undefined) return [];
	const kind = sourceDetail === "video" ? "video" : (mediaKind(url, contentType) ?? (base.embedType === "gifv" ? "gif" : "image"));
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
			...(width === undefined ? {} : { width }),
			...(height === undefined ? {} : { height }),
		},
	];
}

function embedUrlMedia(
	url: string | undefined,
	base: Pick<DiscordMediaSummary, "title" | "provider" | "embedType">,
): DiscordMediaSummary[] {
	if (url === undefined) return [];
	return [
		{
			kind: mediaKind(url, undefined) ?? "link",
			source: "embed",
			url,
			sourceDetail: "url",
			...base,
		},
	];
}

function formatEmbedAsset(value: unknown): {
	url?: string;
	proxyUrl?: string;
	contentType?: string;
	width?: number;
	height?: number;
} {
	if (!isRecord(value)) return {};
	return {
		...(typeof value.url === "string" ? { url: value.url } : {}),
		...(typeof value.proxy_url === "string" ? { proxyUrl: value.proxy_url } : {}),
		...(typeof value.content_type === "string" ? { contentType: value.content_type } : {}),
		...(typeof value.width === "number" ? { width: value.width } : {}),
		...(typeof value.height === "number" ? { height: value.height } : {}),
	};
}

function mediaKind(url: string, contentType: string | undefined): DiscordMediaSummary["kind"] | undefined {
	const lower = `${contentType ?? ""} ${url}`.toLowerCase();
	if (lower.includes("image/gif") || /\.(gif)(\?|#|$)/i.test(url)) return "gif";
	if (lower.includes("image/") || /\.(png|jpe?g|webp|avif)(\?|#|$)/i.test(url)) return "image";
	if (lower.includes("video/") || /\.(mp4|webm|mov|m4v)(\?|#|$)/i.test(url)) return "video";
	return undefined;
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

function extractHttpUrls(text: string): string[] {
	return [...text.matchAll(/https?:\/\/[^\s<>"`]+/giu)].flatMap((match) => {
		const raw = match[0]?.replace(/[),.;!?]+$/u, "");
		if (raw === undefined) return [];
		try {
			return [new URL(raw).toString()];
		} catch {
			return [];
		}
	});
}

async function readDiscordMessagesWithinWindow(
	input: { channelId: string; limit: number; before?: string; after?: string },
	options: DiscordRestOptions,
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
		const params = new URLSearchParams();
		params.set("limit", String(batchLimit));
		if (beforeCursor !== undefined) params.set("before", beforeCursor);
		const json = await discordRequest("GET", `/channels/${encodeURIComponent(input.channelId)}/messages`, undefined, options, {
			query: params,
		});
		if (!Array.isArray(json)) throw new Error("Discord messages response was not an array");
		const batch = json.flatMap(formatMessage).sort(compareMessagesNewestFirst);
		if (batch.length === 0) break;
		let reachedLowerBound = false;
		for (const message of batch) {
			if (lowerBoundId !== undefined && compareRequiredSnowflakes(message.id, lowerBoundId) <= 0) {
				reachedLowerBound = true;
				break;
			}
			const timestamp = resolveMessageTimestampMs(message);
			if (until !== undefined && timestamp !== undefined && timestamp > until.getTime()) continue;
			if (since !== undefined && timestamp !== undefined && timestamp < since.getTime()) {
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

function resolveOptionalTimeBoundary(value: string | undefined, label: string): Date | undefined {
	const trimmed = value?.trim();
	if (trimmed === undefined || trimmed.length === 0) return undefined;
	return parseTimeBoundary(trimmed, label);
}

function parseTimeBoundary(value: string, label: string): Date {
	if (/^now$/iu.test(value)) return new Date();
	const naturalDateMs = parseNaturalDayBoundaryMs(value, label);
	if (Number.isFinite(naturalDateMs)) return new Date(naturalDateMs);
	const relativeDurationMs = parseRelativeDurationMs(value);
	if (relativeDurationMs !== undefined) return new Date(Date.now() - relativeDurationMs);
	const parsed = parseIsoBoundaryMs(value, label);
	if (Number.isFinite(parsed)) return new Date(parsed);
	throw new Error(`${label} must be an ISO timestamp/date, month/day date, "now", or relative duration like 30m, 24h, or 7d`);
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

function parseIsoBoundaryMs(value: string, label: string): number {
	const trimmed = value.trim();
	const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(trimmed);
	if (dateOnly !== null) {
		const year = Number.parseInt(dateOnly[1] ?? "", 10);
		const month = Number.parseInt(dateOnly[2] ?? "", 10) - 1;
		const day = Number.parseInt(dateOnly[3] ?? "", 10);
		return utcDayBoundaryMs(year, month, day, label === "until");
	}
	if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/u.test(trimmed)) return Number.NaN;
	return Date.parse(trimmed);
}

const MONTH_INDEX_BY_NAME: Record<string, number> = {
	jan: 0,
	january: 0,
	feb: 1,
	february: 1,
	mar: 2,
	march: 2,
	apr: 3,
	april: 3,
	may: 4,
	jun: 5,
	june: 5,
	jul: 6,
	july: 6,
	aug: 7,
	august: 7,
	sep: 8,
	sept: 8,
	september: 8,
	oct: 9,
	october: 9,
	nov: 10,
	november: 10,
	dec: 11,
	december: 11,
};

function parseNaturalDayBoundaryMs(value: string, label: string): number {
	const normalized = value.trim().toLowerCase().replace(/,/gu, "").replace(/\s+/gu, " ");
	const explicitEnd = /^(?:end of day|end of|through)\s+/u.test(normalized);
	const explicitStart = /^(?:start of day|start of|beginning of)\s+/u.test(normalized);
	const dayText = normalized.replace(/^(?:on|start of day|start of|beginning of|end of day|end of|through)\s+/u, "");
	const endOfDay = explicitEnd || (!explicitStart && label === "until");
	const today = new Date();
	if (dayText === "today") {
		return utcDayBoundaryMs(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate(), endOfDay);
	}
	if (dayText === "yesterday") {
		return utcDayBoundaryMs(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - 1, endOfDay);
	}
	const match = /^([a-z]+)\s+(\d{1,2})(?:\s+(\d{4}))?$/u.exec(dayText);
	if (match === null) return Number.NaN;
	const month = MONTH_INDEX_BY_NAME[match[1] ?? ""];
	if (month === undefined) return Number.NaN;
	const day = Number.parseInt(match[2] ?? "", 10);
	const year = match[3] === undefined ? inferNaturalDayYear(month, day, today) : Number.parseInt(match[3], 10);
	return utcDayBoundaryMs(year, month, day, endOfDay);
}

function inferNaturalDayYear(month: number, day: number, now: Date): number {
	const year = now.getUTCFullYear();
	const candidate = Date.UTC(year, month, day);
	const tomorrow = Date.UTC(year, now.getUTCMonth(), now.getUTCDate() + 1);
	return candidate > tomorrow ? year - 1 : year;
}

function utcDayBoundaryMs(year: number, month: number, day: number, endOfDay: boolean): number {
	if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return Number.NaN;
	const timestamp = Date.UTC(year, month, day, endOfDay ? 23 : 0, endOfDay ? 59 : 0, endOfDay ? 59 : 0, endOfDay ? 999 : 0);
	const date = new Date(timestamp);
	if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month || date.getUTCDate() !== day) return Number.NaN;
	return timestamp;
}

function normalizeQuery(value: string | undefined): string | undefined {
	const trimmed = value?.trim().toLowerCase();
	return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
}

function trimToUndefined(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
}

function compareMessagesNewestFirst(left: DiscordMessageSummary, right: DiscordMessageSummary): number {
	return compareRequiredSnowflakes(right.id, left.id);
}

function resolveMessageTimestampMs(message: DiscordMessageSummary): number | undefined {
	if (message.timestamp !== undefined) {
		const parsed = Date.parse(message.timestamp);
		if (Number.isFinite(parsed)) return parsed;
	}
	return snowflakeTimestampMs(message.id);
}

function snowflakeTimestamp(value: string): string | undefined {
	const timestamp = snowflakeTimestampMs(value);
	return timestamp === undefined ? undefined : new Date(timestamp).toISOString();
}

function snowflakeTimestampMs(value: string): number | undefined {
	try {
		return Number((BigInt(value) >> 22n) + DISCORD_EPOCH_MS);
	} catch {
		return undefined;
	}
}

function timestampToDiscordSnowflake(timestampMs: number): string {
	// Clamp to the Discord epoch so pre-2015 timestamps (e.g. a model passing Unix seconds or an old
	// date) yield snowflake "0" rather than a negative value, which Discord rejects with a 400.
	const flooredMs = BigInt(Math.max(0, Math.floor(timestampMs)));
	const safeTimestampMs = flooredMs < DISCORD_EPOCH_MS ? DISCORD_EPOCH_MS : flooredMs;
	return ((safeTimestampMs - DISCORD_EPOCH_MS) << 22n).toString();
}

function compareSnowflakes(left: string | undefined, right: string | undefined): number {
	if (left === undefined && right === undefined) return 0;
	if (left === undefined) return 1;
	if (right === undefined) return -1;
	return compareRequiredSnowflakes(left, right);
}

function compareRequiredSnowflakes(left: string, right: string): number {
	try {
		const l = BigInt(left);
		const r = BigInt(right);
		return l === r ? 0 : l < r ? -1 : 1;
	} catch {
		return left.localeCompare(right);
	}
}

function maxDiscordSnowflake(left: string | undefined, right: string | undefined): string | undefined {
	if (left === undefined) return right;
	if (right === undefined) return left;
	return compareRequiredSnowflakes(left, right) >= 0 ? left : right;
}

function minDiscordSnowflake(left: string | undefined, right: string | undefined): string | undefined {
	if (left === undefined) return right;
	if (right === undefined) return left;
	return compareRequiredSnowflakes(left, right) <= 0 ? left : right;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
