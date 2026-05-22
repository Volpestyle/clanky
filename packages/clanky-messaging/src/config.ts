import { readFile, writeFile } from "node:fs/promises";
import type { AllowListConfig } from "./allowlist.ts";
import type { Platform } from "./types.ts";

export interface TelegramPlatformConfig {
	enabled: boolean;
	botToken?: string;
	apiRoot?: string;
	pollingMode: "long_poll" | "webhook" | "disabled";
	webhookUrl?: string;
	webhookSecret?: string;
	parseMode: "MarkdownV2" | "HTML" | "none";
	editRateLimitMs: number;
	bufferThreshold: number;
	freshFinalAfterSeconds: number;
	maxMessageLength: number;
	textBatchDelayMs: number;
	allowList: AllowListConfig;
	autoTtsChats: readonly string[];
	dmTopicsEnabled: boolean;
	ignoredThreads: readonly number[];
	mentionPatterns: readonly string[];
	transcribeMcp?: { server: string; tool: string };
	tts?: { server: string; tool: string };
}

export interface DiscordPlatformConfig {
	enabled: boolean;
	botToken?: string;
	applicationId?: string;
	publicKey?: string;
	commandSyncPolicy: "auto" | "manual" | "off";
	commandSyncMutationIntervalMs: number;
	parseMode: "markdown" | "none";
	editRateLimitMs: number;
	bufferThreshold: number;
	freshFinalAfterSeconds: number;
	maxMessageLength: number;
	allowList: AllowListConfig;
	reactionProgressEnabled: boolean;
	voiceReceiveEnabled: boolean;
	transcribeMcp?: { server: string; tool: string };
	tts?: { server: string; tool: string };
	intentsExtra: readonly string[];
}

export interface MessagingConfig {
	telegram: TelegramPlatformConfig;
	discord: DiscordPlatformConfig;
}

const DEFAULT_TELEGRAM_PARSE_MODE: TelegramPlatformConfig["parseMode"] = "MarkdownV2";
const DEFAULT_EDIT_RATE_LIMIT_MS = 1_000;
const DEFAULT_BUFFER_THRESHOLD = 40;
const DEFAULT_FRESH_FINAL_AFTER_SECONDS = 60;
const DEFAULT_TELEGRAM_MAX_LENGTH = 4_000;
const DEFAULT_DISCORD_MAX_LENGTH = 1_900;
const DEFAULT_TELEGRAM_BATCH_DELAY_MS = 600;
const DEFAULT_DISCORD_SYNC_INTERVAL_MS = 30_000;

export function defaultTelegramConfig(): TelegramPlatformConfig {
	return {
		enabled: false,
		pollingMode: "long_poll",
		parseMode: DEFAULT_TELEGRAM_PARSE_MODE,
		editRateLimitMs: DEFAULT_EDIT_RATE_LIMIT_MS,
		bufferThreshold: DEFAULT_BUFFER_THRESHOLD,
		freshFinalAfterSeconds: DEFAULT_FRESH_FINAL_AFTER_SECONDS,
		maxMessageLength: DEFAULT_TELEGRAM_MAX_LENGTH,
		textBatchDelayMs: DEFAULT_TELEGRAM_BATCH_DELAY_MS,
		allowList: {},
		autoTtsChats: [],
		dmTopicsEnabled: false,
		ignoredThreads: [],
		mentionPatterns: [],
	};
}

export function defaultDiscordConfig(): DiscordPlatformConfig {
	return {
		enabled: false,
		commandSyncPolicy: "auto",
		commandSyncMutationIntervalMs: DEFAULT_DISCORD_SYNC_INTERVAL_MS,
		parseMode: "markdown",
		editRateLimitMs: DEFAULT_EDIT_RATE_LIMIT_MS,
		bufferThreshold: DEFAULT_BUFFER_THRESHOLD,
		freshFinalAfterSeconds: DEFAULT_FRESH_FINAL_AFTER_SECONDS,
		maxMessageLength: DEFAULT_DISCORD_MAX_LENGTH,
		allowList: {},
		reactionProgressEnabled: true,
		voiceReceiveEnabled: false,
		intentsExtra: [],
	};
}

export function loadMessagingConfigFromEnv(env: NodeJS.ProcessEnv = process.env): MessagingConfig {
	const telegram = defaultTelegramConfig();
	const discord = defaultDiscordConfig();

	const tgToken = envString(env.TELEGRAM_BOT_TOKEN ?? env.CLANKY_TELEGRAM_BOT_TOKEN);
	if (tgToken !== undefined) {
		telegram.botToken = tgToken;
		telegram.enabled = true;
	}
	const tgApiRoot = envString(env.TELEGRAM_API_ROOT ?? env.CLANKY_TELEGRAM_API_ROOT);
	if (tgApiRoot !== undefined) telegram.apiRoot = tgApiRoot;
	const tgWebhook = envString(env.CLANKY_TELEGRAM_WEBHOOK_URL);
	if (tgWebhook !== undefined) {
		telegram.webhookUrl = tgWebhook;
		telegram.pollingMode = "webhook";
	}
	const tgWebhookSecret = envString(env.CLANKY_TELEGRAM_WEBHOOK_SECRET);
	if (tgWebhookSecret !== undefined) telegram.webhookSecret = tgWebhookSecret;
	const tgAllowedUsers = envList(env.MESSAGING_TELEGRAM_ALLOWED_USERS);
	if (tgAllowedUsers.length > 0) telegram.allowList.allowedUsers = tgAllowedUsers;
	const tgAllowedChats = envList(env.MESSAGING_TELEGRAM_ALLOWED_CHATS);
	if (tgAllowedChats.length > 0) telegram.allowList.allowedChats = tgAllowedChats;
	const tgDeniedUsers = envList(env.MESSAGING_TELEGRAM_DENIED_USERS);
	if (tgDeniedUsers.length > 0) telegram.allowList.deniedUsers = tgDeniedUsers;
	if (envBool(env.MESSAGING_TELEGRAM_REQUIRE_MENTION) === true) telegram.allowList.requireMentionInGroups = true;
	const tgFreeChats = envList(env.MESSAGING_TELEGRAM_FREE_RESPONSE_CHATS);
	if (tgFreeChats.length > 0) telegram.allowList.freeResponseChats = tgFreeChats;
	const tgParseMode = envString(env.MESSAGING_TELEGRAM_PARSE_MODE);
	if (tgParseMode === "MarkdownV2" || tgParseMode === "HTML" || tgParseMode === "none")
		telegram.parseMode = tgParseMode;
	const tgDmTopics = envBool(env.MESSAGING_TELEGRAM_DM_TOPICS);
	if (tgDmTopics === true) telegram.dmTopicsEnabled = true;
	const tgTranscribe = envMcpRef(env.MESSAGING_TELEGRAM_TRANSCRIBE);
	if (tgTranscribe !== undefined) telegram.transcribeMcp = tgTranscribe;
	const tgTts = envMcpRef(env.MESSAGING_TELEGRAM_TTS);
	if (tgTts !== undefined) telegram.tts = tgTts;
	const tgAutoTts = envList(env.MESSAGING_TELEGRAM_AUTO_TTS_CHATS);
	if (tgAutoTts.length > 0) telegram.autoTtsChats = tgAutoTts;
	const tgMaxLength = envInt(env.MESSAGING_TELEGRAM_MAX_MESSAGE_LENGTH);
	if (tgMaxLength !== undefined) telegram.maxMessageLength = tgMaxLength;
	const tgEditRate = envInt(env.MESSAGING_TELEGRAM_EDIT_RATE_MS);
	if (tgEditRate !== undefined) telegram.editRateLimitMs = tgEditRate;
	const tgBatchDelay = envInt(env.MESSAGING_TELEGRAM_BATCH_DELAY_MS);
	if (tgBatchDelay !== undefined) telegram.textBatchDelayMs = tgBatchDelay;
	const tgIgnoredThreads = envIntList(env.MESSAGING_TELEGRAM_IGNORED_THREADS);
	if (tgIgnoredThreads.length > 0) telegram.ignoredThreads = tgIgnoredThreads;
	const tgMentionPatterns = envList(env.MESSAGING_TELEGRAM_MENTION_PATTERNS);
	if (tgMentionPatterns.length > 0) telegram.mentionPatterns = tgMentionPatterns;

	const dcToken = envString(env.DISCORD_BOT_TOKEN ?? env.CLANKY_DISCORD_BOT_TOKEN);
	if (dcToken !== undefined) {
		discord.botToken = dcToken;
		discord.enabled = true;
	}
	const dcAppId = envString(env.DISCORD_APPLICATION_ID ?? env.CLANKY_DISCORD_APPLICATION_ID);
	if (dcAppId !== undefined) discord.applicationId = dcAppId;
	const dcPublicKey = envString(env.DISCORD_PUBLIC_KEY ?? env.CLANKY_DISCORD_PUBLIC_KEY);
	if (dcPublicKey !== undefined) discord.publicKey = dcPublicKey;
	const dcAllowedUsers = envList(env.MESSAGING_DISCORD_ALLOWED_USERS);
	if (dcAllowedUsers.length > 0) discord.allowList.allowedUsers = dcAllowedUsers;
	const dcAllowedChats = envList(env.MESSAGING_DISCORD_ALLOWED_CHANNELS);
	if (dcAllowedChats.length > 0) discord.allowList.allowedChats = dcAllowedChats;
	const dcAllowedGuilds = envList(env.MESSAGING_DISCORD_ALLOWED_GUILDS);
	if (dcAllowedGuilds.length > 0) discord.allowList.allowedGuilds = dcAllowedGuilds;
	const dcDeniedUsers = envList(env.MESSAGING_DISCORD_DENIED_USERS);
	if (dcDeniedUsers.length > 0) discord.allowList.deniedUsers = dcDeniedUsers;
	const dcSyncPolicy = envString(env.MESSAGING_DISCORD_COMMAND_SYNC);
	if (dcSyncPolicy === "auto" || dcSyncPolicy === "manual" || dcSyncPolicy === "off")
		discord.commandSyncPolicy = dcSyncPolicy;
	if (envBool(env.MESSAGING_DISCORD_REACTIONS) === false) discord.reactionProgressEnabled = false;
	if (envBool(env.MESSAGING_DISCORD_VOICE_RECEIVE) === true) discord.voiceReceiveEnabled = true;
	const dcTranscribe = envMcpRef(env.MESSAGING_DISCORD_TRANSCRIBE);
	if (dcTranscribe !== undefined) discord.transcribeMcp = dcTranscribe;
	const dcTts = envMcpRef(env.MESSAGING_DISCORD_TTS);
	if (dcTts !== undefined) discord.tts = dcTts;
	const dcMaxLength = envInt(env.MESSAGING_DISCORD_MAX_MESSAGE_LENGTH);
	if (dcMaxLength !== undefined) discord.maxMessageLength = dcMaxLength;
	const dcEditRate = envInt(env.MESSAGING_DISCORD_EDIT_RATE_MS);
	if (dcEditRate !== undefined) discord.editRateLimitMs = dcEditRate;

	return { telegram, discord };
}

export async function readPersistedPlatformConfig(file: string): Promise<Partial<MessagingConfig> | undefined> {
	const text = await readFile(file, "utf8").catch(() => undefined);
	if (text === undefined) return undefined;
	try {
		const parsed = JSON.parse(text) as unknown;
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
		return parsed as Partial<MessagingConfig>;
	} catch {
		return undefined;
	}
}

export async function writePersistedPlatformConfig(file: string, config: Partial<MessagingConfig>): Promise<void> {
	await writeFile(file, `${JSON.stringify(config, null, "\t")}\n`, { mode: 0o600 });
}

export function configEnabled(config: MessagingConfig, platform: Platform): boolean {
	if (platform === "telegram") return config.telegram.enabled && config.telegram.botToken !== undefined;
	return config.discord.enabled && config.discord.botToken !== undefined;
}

function envString(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
}

function envBool(value: string | undefined): boolean | undefined {
	const normalized = envString(value)?.toLowerCase();
	if (normalized === undefined) return undefined;
	if (normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on") return true;
	if (normalized === "0" || normalized === "false" || normalized === "no" || normalized === "off") return false;
	return undefined;
}

function envInt(value: string | undefined): number | undefined {
	const normalized = envString(value);
	if (normalized === undefined) return undefined;
	const parsed = Number.parseInt(normalized, 10);
	return Number.isFinite(parsed) ? parsed : undefined;
}

function envList(value: string | undefined): string[] {
	const normalized = envString(value);
	if (normalized === undefined) return [];
	return normalized
		.split(",")
		.map((item) => item.trim())
		.filter((item) => item.length > 0);
}

function envIntList(value: string | undefined): number[] {
	return envList(value)
		.map((item) => Number.parseInt(item, 10))
		.filter((value) => Number.isFinite(value));
}

function envMcpRef(value: string | undefined): { server: string; tool: string } | undefined {
	const normalized = envString(value);
	if (normalized === undefined) return undefined;
	const sep = normalized.indexOf(":");
	if (sep <= 0 || sep === normalized.length - 1) return undefined;
	return { server: normalized.slice(0, sep), tool: normalized.slice(sep + 1) };
}
