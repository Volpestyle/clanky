import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { OpenAiRealtimeReasoningEffort } from "./voice/openAiRealtimeClient.ts";

export interface StoredDiscordVoiceSettings {
	enabled: boolean;
	guildId?: string;
	channelId?: string;
	openAiRealtimeModel?: string;
	openAiRealtimeVoice?: string;
	openAiRealtimeReasoningEffort?: OpenAiRealtimeReasoningEffort;
	videoFrameAutoAttachIntervalMs?: number;
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
	const guildId = cleanString(settings.guildId);
	if (guildId !== undefined) sanitized.guildId = guildId;
	const channelId = cleanString(settings.channelId);
	if (channelId !== undefined) sanitized.channelId = channelId;
	const model = cleanString(settings.openAiRealtimeModel);
	if (model !== undefined) sanitized.openAiRealtimeModel = model;
	const voice = cleanString(settings.openAiRealtimeVoice);
	if (voice !== undefined) sanitized.openAiRealtimeVoice = voice;
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
	return sanitized;
}

function parseStoredDiscordVoiceSettings(value: unknown): StoredDiscordVoiceSettings | undefined {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
	const record = value as Record<string, unknown>;
	const settings: StoredDiscordVoiceSettings = { enabled: record.enabled === true };
	if (typeof record.guildId === "string") settings.guildId = record.guildId;
	if (typeof record.channelId === "string") settings.channelId = record.channelId;
	if (typeof record.openAiRealtimeModel === "string") settings.openAiRealtimeModel = record.openAiRealtimeModel;
	if (typeof record.openAiRealtimeVoice === "string") settings.openAiRealtimeVoice = record.openAiRealtimeVoice;
	if (isRealtimeReasoningEffort(record.openAiRealtimeReasoningEffort)) {
		settings.openAiRealtimeReasoningEffort = record.openAiRealtimeReasoningEffort;
	}
	if (typeof record.videoFrameAutoAttachIntervalMs === "number") {
		settings.videoFrameAutoAttachIntervalMs = record.videoFrameAutoAttachIntervalMs;
	}
	return sanitizeStoredDiscordVoiceSettings(settings);
}

function cleanString(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	return trimmed !== undefined && trimmed.length > 0 ? trimmed : undefined;
}

function isRealtimeReasoningEffort(value: unknown): value is OpenAiRealtimeReasoningEffort {
	return value === "minimal" || value === "low" || value === "medium" || value === "high" || value === "xhigh";
}
