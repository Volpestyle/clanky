#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const [guildId, channelId, limitArg] = process.argv.slice(2);
if (!guildId || !channelId) {
	console.error("usage: read-discord-channel.mjs <guild_id> <channel_id> [limit]");
	process.exit(2);
}

const repo = resolve(process.env.CLANKY_REPO_DIR ?? process.cwd());
loadEnvFile(join(repo, ".env.local"));
const restModule = pathToFileURL(join(repo, "agent", "lib", "discord", "rest.ts")).href;
const { discordListChannels, discordReadMessages, discordWhoami } = await import(restModule);
const limit = Math.max(1, Math.min(50, Number.parseInt(limitArg ?? "12", 10) || 12));

try {
	const identity = await discordWhoami();
	const channels = await discordListChannels(guildId);
	const channel = channels.find((item) => item.id === channelId);
	const messages = await discordReadMessages({ channelId, limit });
	console.log(
		JSON.stringify(
			{
				identity: {
					id: identity.id,
					username: identity.username,
					...(identity.globalName === undefined ? {} : { globalName: identity.globalName }),
					bot: identity.bot ?? false,
				},
				channel: channel ?? null,
				messages: messages.map((message) => ({
					id: message.id,
					authorUsername: message.authorUsername,
					authorId: message.authorId,
					content: message.content,
					timestamp: message.timestamp,
				})),
			},
			null,
			2,
		),
	);
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(1);
}

function loadEnvFile(path) {
	if (!existsSync(path)) return;
	for (const rawLine of readFileSync(path, "utf8").split(/\r?\n/u)) {
		const line = rawLine.trim();
		if (!line || line.startsWith("#")) continue;
		const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/u);
		if (!match) continue;
		const key = match[1];
		let value = match[2] ?? "";
		if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
			value = value.slice(1, -1);
		}
		process.env[key] = value;
	}
}
