import { join } from "node:path";
import type { ClankyPaths } from "@clanky/core";
import type { Platform } from "./types.ts";

export interface MessagingPaths {
	messagingDir: string;
	telegramDir: string;
	telegramSessionsFile: string;
	telegramConfigFile: string;
	telegramStateDir: string;
	discordDir: string;
	discordSessionsFile: string;
	discordConfigFile: string;
	discordStateDir: string;
	pairingFile: string;
	stickerCacheDir: string;
	mirrorFile: string;
	hooksDir: string;
	transcribeCacheDir: string;
}

export function resolveMessagingPaths(paths: ClankyPaths): MessagingPaths {
	const messagingDir = join(paths.profileDir, "messaging");
	const telegramDir = join(messagingDir, "telegram");
	const discordDir = join(messagingDir, "discord");
	return {
		messagingDir,
		telegramDir,
		telegramSessionsFile: join(telegramDir, "sessions.json"),
		telegramConfigFile: join(telegramDir, "config.json"),
		telegramStateDir: join(telegramDir, "state"),
		discordDir,
		discordSessionsFile: join(discordDir, "sessions.json"),
		discordConfigFile: join(discordDir, "config.json"),
		discordStateDir: join(discordDir, "state"),
		pairingFile: join(messagingDir, "pairing.json"),
		stickerCacheDir: join(messagingDir, ".stickers"),
		mirrorFile: join(messagingDir, "mirror.json"),
		hooksDir: join(paths.profileDir, "messaging-hooks"),
		transcribeCacheDir: join(messagingDir, ".transcribe"),
	};
}

export function platformDir(paths: MessagingPaths, platform: Platform): string {
	return platform === "telegram" ? paths.telegramDir : paths.discordDir;
}

export function platformSessionsFile(paths: MessagingPaths, platform: Platform): string {
	return platform === "telegram" ? paths.telegramSessionsFile : paths.discordSessionsFile;
}

export function platformConfigFile(paths: MessagingPaths, platform: Platform): string {
	return platform === "telegram" ? paths.telegramConfigFile : paths.discordConfigFile;
}

export function platformStateDir(paths: MessagingPaths, platform: Platform): string {
	return platform === "telegram" ? paths.telegramStateDir : paths.discordStateDir;
}
