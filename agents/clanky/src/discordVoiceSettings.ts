import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { type ElevenLabsPcmOutputFormat, parseElevenLabsPcmOutputFormat } from "./voice/elevenLabsTtsClient.ts";
import type { OpenAiRealtimeReasoningEffort } from "./voice/openAiRealtimeClient.ts";

export type DiscordVoiceTtsProvider = "openai" | "elevenlabs";
export type DiscordVoiceRealtimeAgentProvider = "openai" | "xai";

export interface StoredDiscordVoiceSettings {
	enabled: boolean;
	autoJoin?: boolean;
	guildId?: string;
	channelId?: string;
	allowedGuildIds?: string[];
	allowedChannelIds?: string[];
	realtimeAgentProvider?: DiscordVoiceRealtimeAgentProvider;
	ttsProvider?: DiscordVoiceTtsProvider;
	openAiRealtimeModel?: string;
	openAiRealtimeVoice?: string;
	openAiRealtimeReasoningEffort?: OpenAiRealtimeReasoningEffort;
	xAiRealtimeModel?: string;
	xAiRealtimeVoice?: string;
	elevenLabsVoiceId?: string;
	elevenLabsModel?: string;
	elevenLabsOutputFormat?: ElevenLabsPcmOutputFormat;
	elevenLabsBaseUrl?: string;
	videoFrameAutoAttachIntervalMs?: number;
	participationEagerness?: number;
}

export interface DiscordVoiceSettingsAccessor {
	readonly path: string;
	read(): StoredDiscordVoiceSettings | undefined;
	write(settings: StoredDiscordVoiceSettings): void;
	clear(): boolean;
}

export class DiscordVoiceSettingsStore implements DiscordVoiceSettingsAccessor {
	readonly path: string;

	constructor(path: string) {
		this.path = path;
	}

	read(): StoredDiscordVoiceSettings | undefined {
		if (!existsSync(this.path)) return undefined;
		try {
			const parsed = JSON.parse(readFileSync(this.path, "utf8")) as unknown;
			return parseStoredDiscordVoiceSettings(parsed);
		} catch {
			return undefined;
		}
	}

	write(settings: StoredDiscordVoiceSettings): void {
		const sanitized = sanitizeStoredDiscordVoiceSettings(settings);
		mkdirSync(dirname(this.path), { recursive: true });
		writeFileSync(this.path, `${JSON.stringify(sanitized, null, 2)}\n`, { mode: 0o600 });
	}

	clear(): boolean {
		if (!existsSync(this.path)) return false;
		unlinkSync(this.path);
		return true;
	}
}

export function sanitizeStoredDiscordVoiceSettings(settings: StoredDiscordVoiceSettings): StoredDiscordVoiceSettings {
	const sanitized: StoredDiscordVoiceSettings = { enabled: settings.enabled === true };
	if (settings.autoJoin === true) sanitized.autoJoin = true;
	const guildId = cleanString(settings.guildId);
	if (guildId !== undefined) sanitized.guildId = guildId;
	const channelId = cleanString(settings.channelId);
	if (channelId !== undefined) sanitized.channelId = channelId;
	const allowedGuildIds = cleanStringList(settings.allowedGuildIds);
	if (allowedGuildIds.length > 0) sanitized.allowedGuildIds = allowedGuildIds;
	const allowedChannelIds = cleanStringList(settings.allowedChannelIds);
	if (allowedChannelIds.length > 0) sanitized.allowedChannelIds = allowedChannelIds;
	if (isDiscordVoiceRealtimeAgentProvider(settings.realtimeAgentProvider)) {
		sanitized.realtimeAgentProvider = settings.realtimeAgentProvider;
	}
	if (isDiscordVoiceTtsProvider(settings.ttsProvider)) sanitized.ttsProvider = settings.ttsProvider;
	const model = cleanString(settings.openAiRealtimeModel);
	if (model !== undefined) sanitized.openAiRealtimeModel = model;
	const voice = cleanString(settings.openAiRealtimeVoice);
	if (voice !== undefined) sanitized.openAiRealtimeVoice = voice;
	const xAiModel = cleanString(settings.xAiRealtimeModel);
	if (xAiModel !== undefined) sanitized.xAiRealtimeModel = xAiModel;
	const xAiVoice = cleanString(settings.xAiRealtimeVoice);
	if (xAiVoice !== undefined) sanitized.xAiRealtimeVoice = xAiVoice;
	const elevenLabsVoiceId = cleanString(settings.elevenLabsVoiceId);
	if (elevenLabsVoiceId !== undefined) sanitized.elevenLabsVoiceId = elevenLabsVoiceId;
	const elevenLabsModel = cleanString(settings.elevenLabsModel);
	if (elevenLabsModel !== undefined) sanitized.elevenLabsModel = elevenLabsModel;
	const elevenLabsOutputFormat = parseElevenLabsPcmOutputFormat(settings.elevenLabsOutputFormat);
	if (elevenLabsOutputFormat !== undefined) sanitized.elevenLabsOutputFormat = elevenLabsOutputFormat;
	const elevenLabsBaseUrl = cleanString(settings.elevenLabsBaseUrl);
	if (elevenLabsBaseUrl !== undefined) sanitized.elevenLabsBaseUrl = elevenLabsBaseUrl.replace(/\/+$/, "");
	if (isRealtimeReasoningEffort(settings.openAiRealtimeReasoningEffort)) {
		sanitized.openAiRealtimeReasoningEffort = settings.openAiRealtimeReasoningEffort;
	}
	if (
		typeof settings.videoFrameAutoAttachIntervalMs === "number" &&
		Number.isFinite(settings.videoFrameAutoAttachIntervalMs) &&
		settings.videoFrameAutoAttachIntervalMs >= 0
	) {
		sanitized.videoFrameAutoAttachIntervalMs = Math.trunc(settings.videoFrameAutoAttachIntervalMs);
	}
	if (typeof settings.participationEagerness === "number" && Number.isFinite(settings.participationEagerness)) {
		sanitized.participationEagerness = clampInteger(settings.participationEagerness, 0, 100);
	}
	return sanitized;
}

function parseStoredDiscordVoiceSettings(value: unknown): StoredDiscordVoiceSettings | undefined {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
	const record = value as Record<string, unknown>;
	const settings: StoredDiscordVoiceSettings = { enabled: record.enabled === true };
	if (typeof record.autoJoin === "boolean") settings.autoJoin = record.autoJoin;
	if (typeof record.guildId === "string") settings.guildId = record.guildId;
	if (typeof record.channelId === "string") settings.channelId = record.channelId;
	if (Array.isArray(record.allowedGuildIds)) {
		settings.allowedGuildIds = record.allowedGuildIds.filter((item): item is string => typeof item === "string");
	}
	if (Array.isArray(record.allowedChannelIds)) {
		settings.allowedChannelIds = record.allowedChannelIds.filter((item): item is string => typeof item === "string");
	}
	if (isDiscordVoiceRealtimeAgentProvider(record.realtimeAgentProvider)) {
		settings.realtimeAgentProvider = record.realtimeAgentProvider;
	}
	if (isDiscordVoiceTtsProvider(record.ttsProvider)) settings.ttsProvider = record.ttsProvider;
	if (typeof record.openAiRealtimeModel === "string") settings.openAiRealtimeModel = record.openAiRealtimeModel;
	if (typeof record.openAiRealtimeVoice === "string") settings.openAiRealtimeVoice = record.openAiRealtimeVoice;
	if (typeof record.xAiRealtimeModel === "string") settings.xAiRealtimeModel = record.xAiRealtimeModel;
	if (typeof record.xAiRealtimeVoice === "string") settings.xAiRealtimeVoice = record.xAiRealtimeVoice;
	if (typeof record.elevenLabsVoiceId === "string") settings.elevenLabsVoiceId = record.elevenLabsVoiceId;
	if (typeof record.elevenLabsModel === "string") settings.elevenLabsModel = record.elevenLabsModel;
	const elevenLabsOutputFormat = parseElevenLabsPcmOutputFormat(readString(record.elevenLabsOutputFormat));
	if (elevenLabsOutputFormat !== undefined) settings.elevenLabsOutputFormat = elevenLabsOutputFormat;
	if (typeof record.elevenLabsBaseUrl === "string") settings.elevenLabsBaseUrl = record.elevenLabsBaseUrl;
	if (isRealtimeReasoningEffort(record.openAiRealtimeReasoningEffort)) {
		settings.openAiRealtimeReasoningEffort = record.openAiRealtimeReasoningEffort;
	}
	if (typeof record.videoFrameAutoAttachIntervalMs === "number") {
		settings.videoFrameAutoAttachIntervalMs = record.videoFrameAutoAttachIntervalMs;
	}
	if (typeof record.participationEagerness === "number") {
		settings.participationEagerness = record.participationEagerness;
	}
	return sanitizeStoredDiscordVoiceSettings(settings);
}

function clampInteger(value: number, min: number, max: number): number {
	const integer = Math.trunc(value);
	if (integer < min) return min;
	if (integer > max) return max;
	return integer;
}

function cleanString(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	return trimmed !== undefined && trimmed.length > 0 ? trimmed : undefined;
}

function readString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function cleanStringList(values: string[] | undefined): string[] {
	if (values === undefined) return [];
	const seen = new Set<string>();
	const cleaned: string[] = [];
	for (const value of values) {
		const item = cleanString(value);
		if (item === undefined || seen.has(item)) continue;
		seen.add(item);
		cleaned.push(item);
	}
	return cleaned;
}

function isRealtimeReasoningEffort(value: unknown): value is OpenAiRealtimeReasoningEffort {
	return value === "minimal" || value === "low" || value === "medium" || value === "high" || value === "xhigh";
}

function isDiscordVoiceTtsProvider(value: unknown): value is DiscordVoiceTtsProvider {
	return value === "openai" || value === "elevenlabs";
}

function isDiscordVoiceRealtimeAgentProvider(value: unknown): value is DiscordVoiceRealtimeAgentProvider {
	return value === "openai" || value === "xai";
}
