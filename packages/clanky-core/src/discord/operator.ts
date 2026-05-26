import type { AuthStorage } from "@earendil-works/pi-coding-agent";
import {
	addDiscordReaction as addDiscordReactionBase,
	type DiscordAddReactionInput,
	type DiscordAddReactionResult,
	type DiscordChannelSummary,
	type DiscordCredentialKind,
	type DiscordEmojiSummary,
	type DiscordGuildSummary,
	type DiscordListChannelsInput,
	type DiscordListEmojisInput,
	type DiscordLoadedImageContent,
	type DiscordOperatorOptions as DiscordMcpOperatorOptions,
	type DiscordMessageAttachmentSummary,
	type DiscordMessageMediaKind,
	type DiscordMessageMediaSource,
	type DiscordMessageMediaSummary,
	type DiscordMessageSummary,
	type DiscordParticipantSummary,
	type DiscordReadMessagesInput,
	type DiscordRecentActivityInput,
	type DiscordRecentActivityResult,
	type DiscordRecentAttachmentFailure,
	type DiscordRecentAttachmentLoadedImageSummary,
	type DiscordRecentAttachmentMediaResult,
	type DiscordRecentAttachmentStatus,
	type DiscordRecentAttachmentsInput,
	type DiscordRecentAttachmentsResult,
	type DiscordRecentChannelActivitySummary,
	type DiscordSendMessageInput,
	type DiscordSendMessageResult,
	listDiscordChannels as listDiscordChannelsBase,
	listDiscordEmojis as listDiscordEmojisBase,
	listDiscordGuilds as listDiscordGuildsBase,
	readDiscordMessages as readDiscordMessagesBase,
	recentDiscordActivity as recentDiscordActivityBase,
	recentDiscordAttachments as recentDiscordAttachmentsBase,
	resolveDiscordOperatorCredential as resolveDiscordMcpCredential,
	sendDiscordMessage as sendDiscordMessageBase,
} from "discord-mcp";
import {
	type ClankyDiscordCredentialKind,
	DEFAULT_CLANKY_DISCORD_PROVIDER_ID,
	loadStoredDiscordCredential,
} from "../discord-credentials.ts";

export type {
	DiscordAddReactionInput,
	DiscordAddReactionResult,
	DiscordChannelSummary,
	DiscordEmojiSummary,
	DiscordGuildSummary,
	DiscordLoadedImageContent,
	DiscordListChannelsInput,
	DiscordListEmojisInput,
	DiscordMessageAttachmentSummary,
	DiscordMessageMediaKind,
	DiscordMessageMediaSource,
	DiscordMessageMediaSummary,
	DiscordMessageSummary,
	DiscordParticipantSummary,
	DiscordReadMessagesInput,
	DiscordRecentActivityInput,
	DiscordRecentActivityResult,
	DiscordRecentAttachmentFailure,
	DiscordRecentAttachmentLoadedImageSummary,
	DiscordRecentAttachmentMediaResult,
	DiscordRecentAttachmentStatus,
	DiscordRecentAttachmentsInput,
	DiscordRecentAttachmentsResult,
	DiscordRecentChannelActivitySummary,
	DiscordSendMessageInput,
	DiscordSendMessageResult,
};

export interface DiscordOperatorOptions extends Omit<DiscordMcpOperatorOptions, "env"> {
	authStorage?: AuthStorage;
	env?: NodeJS.ProcessEnv;
}

export interface ResolvedDiscordCredential {
	providerId: string;
	token: string;
	credentialKind: ClankyDiscordCredentialKind;
	source: "env" | "stored";
}

export function resolveDiscordOperatorCredential(options: DiscordOperatorOptions = {}): ResolvedDiscordCredential {
	const env = options.env ?? process.env;
	const providerId = env.CLANKY_DISCORD_PROVIDER_ID?.trim() || DEFAULT_CLANKY_DISCORD_PROVIDER_ID;
	const envToken = env.CLANKY_DISCORD_TOKEN?.trim();
	if (envToken !== undefined && envToken.length > 0) {
		return {
			providerId,
			token: envToken,
			credentialKind: normalizeCredentialKind(env.CLANKY_DISCORD_CREDENTIAL_KIND),
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
	const resolved = resolveDiscordMcpCredential(options);
	return {
		providerId: resolved.providerId,
		token: resolved.token,
		credentialKind: normalizeCredentialKind(resolved.credentialKind),
		source: resolved.source,
	};
}

export async function listDiscordGuilds(options: DiscordOperatorOptions = {}): Promise<DiscordGuildSummary[]> {
	return await listDiscordGuildsBase(toDiscordMcpOptions(options));
}

export async function listDiscordChannels(
	input: DiscordListChannelsInput,
	options: DiscordOperatorOptions = {},
): Promise<DiscordChannelSummary[]> {
	return await listDiscordChannelsBase(input, toDiscordMcpOptions(options));
}

export async function readDiscordMessages(
	input: DiscordReadMessagesInput,
	options: DiscordOperatorOptions = {},
): Promise<DiscordMessageSummary[]> {
	return await readDiscordMessagesBase(input, toDiscordMcpOptions(options));
}

export async function recentDiscordActivity(
	input: DiscordRecentActivityInput,
	options: DiscordOperatorOptions = {},
): Promise<DiscordRecentActivityResult> {
	return await recentDiscordActivityBase(input, toDiscordMcpOptions(options));
}

export async function recentDiscordAttachments(
	input: DiscordRecentAttachmentsInput,
	options: DiscordOperatorOptions = {},
): Promise<DiscordRecentAttachmentsResult> {
	return await recentDiscordAttachmentsBase(input, toDiscordMcpOptions(options));
}

export async function sendDiscordMessage(
	input: DiscordSendMessageInput,
	options: DiscordOperatorOptions = {},
): Promise<DiscordSendMessageResult> {
	return await sendDiscordMessageBase(input, toDiscordMcpOptions(options));
}

export async function listDiscordEmojis(
	input: DiscordListEmojisInput,
	options: DiscordOperatorOptions = {},
): Promise<DiscordEmojiSummary[]> {
	return await listDiscordEmojisBase(input, toDiscordMcpOptions(options));
}

export async function addDiscordReaction(
	input: DiscordAddReactionInput,
	options: DiscordOperatorOptions = {},
): Promise<DiscordAddReactionResult> {
	return await addDiscordReactionBase(input, toDiscordMcpOptions(options));
}

function toDiscordMcpOptions(options: DiscordOperatorOptions): DiscordMcpOperatorOptions {
	const credential = resolveDiscordOperatorCredential(options);
	const env = {
		...(options.env ?? process.env),
		DISCORD_MCP_PROVIDER_ID: credential.providerId,
		DISCORD_MCP_TOKEN: credential.token,
		DISCORD_MCP_CREDENTIAL_KIND: credential.credentialKind,
	};
	return {
		env,
		...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
		...(options.signal === undefined ? {} : { signal: options.signal }),
		...(options.credentialsPath === undefined ? {} : { credentialsPath: options.credentialsPath }),
	};
}

function normalizeCredentialKind(value: string | DiscordCredentialKind | undefined): ClankyDiscordCredentialKind {
	return value === "user-token" ? "user-token" : "bot-token";
}
