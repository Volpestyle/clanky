#!/usr/bin/env node
import {
	addDiscordReaction,
	listDiscordChannels,
	listDiscordEmojis,
	listDiscordGuilds,
	readDiscordMessages,
	recentDiscordActivity,
	resolveClankyPaths,
	sendDiscordMessage,
} from "@clanky/core";
import { AuthStorage } from "@earendil-works/pi-coding-agent";
import { type RunClankyOptions, runClanky } from "./runClanky.ts";

const args = process.argv.slice(2);

if (args[0] === "discord") {
	runDiscordCli(args.slice(1)).catch((error: unknown) => {
		console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
		process.exit(1);
	});
} else {
	const options: RunClankyOptions = {};
	for (let i = 0; i < args.length; i++) {
		const a = args[i];
		if (a === undefined) continue;
		const next = args[i + 1];
		if (a === "--profile" && next !== undefined) {
			options.profile = next;
			i++;
		} else if (a === "--home" && next !== undefined) {
			options.homeDir = next;
			i++;
		} else if (a === "--cwd" && next !== undefined) {
			options.cwd = next;
			i++;
		} else if (a === "--message" && next !== undefined) {
			options.initialMessage = next;
			i++;
		} else if (a === "--help" || a === "-h") {
			console.log("Usage: clanky [--profile <name>] [--home <dir>] [--cwd <dir>] [--message <text>]");
			console.log("       clanky discord <guilds|channels|messages|recent|digest|send|emojis|react> [...]");
			process.exit(0);
		} else {
			console.error(`Unknown argument: ${a}`);
			process.exit(2);
		}
	}

	runClanky(options).catch((error: unknown) => {
		console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
		process.exit(1);
	});
}

async function runDiscordCli(rawArgs: string[]): Promise<void> {
	const parsed = parseDiscordCliArgs(rawArgs);
	if (parsed.help || parsed.command === undefined) {
		printDiscordHelp();
		return;
	}
	const paths = resolveClankyPaths({
		...(parsed.homeDir === undefined ? {} : { homeDir: parsed.homeDir }),
		...(parsed.profile === undefined ? {} : { profile: parsed.profile }),
	});
	const authStorage = AuthStorage.create(paths.authFile);
	const options = { authStorage };

	if (parsed.command === "guilds") {
		console.log(JSON.stringify(await listDiscordGuilds(options), null, "\t"));
		return;
	}
	if (parsed.command === "channels") {
		const guild = await resolveGuildArg(parsed.positionals[0], options);
		console.log(
			JSON.stringify(
				await listDiscordChannels(
					{
						guildId: guild.id,
						...(parsed.since === undefined ? {} : { since: parsed.since }),
					},
					options,
				),
				null,
				"\t",
			),
		);
		return;
	}
	if (parsed.command === "messages") {
		const channelId = requiredArg(parsed.positionals[0], "channel id");
		console.log(
			JSON.stringify(
				await readDiscordMessages(
					{
						channelId,
						...(parsed.limit === undefined ? {} : { limit: parsed.limit }),
						...(parsed.since === undefined ? {} : { since: parsed.since }),
						...(parsed.until === undefined ? {} : { until: parsed.until }),
					},
					options,
				),
				null,
				"\t",
			),
		);
		return;
	}
	if (parsed.command === "recent" || parsed.command === "digest") {
		const guild = await resolveGuildArg(parsed.positionals[0], options, { allowOmittedWhenSingleGuild: true });
		console.log(
			JSON.stringify(
				await recentDiscordActivity(
					{
						guildId: guild.id,
						...(parsed.since === undefined ? {} : { since: parsed.since }),
						...(parsed.channelsLimit === undefined ? {} : { limitChannels: parsed.channelsLimit }),
						...(parsed.messagesLimit === undefined ? {} : { messageLimit: parsed.messagesLimit }),
						...(parsed.channelQuery === undefined ? {} : { channelNameQuery: parsed.channelQuery }),
					},
					options,
				),
				null,
				"\t",
			),
		);
		return;
	}
	if (parsed.command === "send") {
		const channelId = requiredArg(parsed.positionals[0], "channel id");
		const content = parsed.positionals.slice(1).join(" ");
		console.log(
			JSON.stringify(await sendDiscordMessage({ channelId, content, filePaths: parsed.files }, options), null, "\t"),
		);
		return;
	}
	if (parsed.command === "emojis") {
		const guild = await resolveGuildArg(parsed.positionals[0], options);
		console.log(JSON.stringify(await listDiscordEmojis({ guildId: guild.id }, options), null, "\t"));
		return;
	}
	if (parsed.command === "react") {
		const channelId = requiredArg(parsed.positionals[0], "channel id");
		const messageId = requiredArg(parsed.positionals[1], "message id");
		const emoji = requiredArg(parsed.positionals[2], "emoji");
		console.log(JSON.stringify(await addDiscordReaction({ channelId, messageId, emoji }, options), null, "\t"));
		return;
	}
	throw new Error(`Unknown discord command: ${parsed.command}`);
}

interface ParsedDiscordCliArgs {
	command?: string;
	positionals: string[];
	files: string[];
	limit?: number;
	since?: string;
	until?: string;
	channelQuery?: string;
	channelsLimit?: number;
	messagesLimit?: number;
	profile?: string;
	homeDir?: string;
	help: boolean;
}

interface ResolvedDiscordGuildArg {
	id: string;
	name: string;
}

interface ResolveGuildArgOptions {
	allowOmittedWhenSingleGuild?: boolean;
}

function parseDiscordCliArgs(rawArgs: string[]): ParsedDiscordCliArgs {
	const parsed: ParsedDiscordCliArgs = { positionals: [], files: [], help: false };
	for (let i = 0; i < rawArgs.length; i++) {
		const arg = rawArgs[i];
		if (arg === undefined) continue;
		const next = rawArgs[i + 1];
		if (arg === "--help" || arg === "-h") {
			parsed.help = true;
		} else if (arg === "--profile" && next !== undefined) {
			parsed.profile = next;
			i++;
		} else if (arg === "--home" && next !== undefined) {
			parsed.homeDir = next;
			i++;
		} else if ((arg === "--file" || arg === "-f") && next !== undefined) {
			parsed.files.push(next);
			i++;
		} else if (arg === "--limit" && next !== undefined) {
			parsed.limit = parseNumberFlag(next, "--limit");
			i++;
		} else if (arg === "--since" && next !== undefined) {
			parsed.since = next;
			i++;
		} else if (arg === "--until" && next !== undefined) {
			parsed.until = next;
			i++;
		} else if (arg === "--channel" && next !== undefined) {
			parsed.channelQuery = next;
			i++;
		} else if (arg === "--channels" && next !== undefined) {
			parsed.channelsLimit = parseNumberFlag(next, "--channels");
			i++;
		} else if (arg === "--messages" && next !== undefined) {
			parsed.messagesLimit = parseNumberFlag(next, "--messages");
			i++;
		} else if (parsed.command === undefined) {
			parsed.command = arg;
		} else {
			parsed.positionals.push(arg);
		}
	}
	return parsed;
}

async function resolveGuildArg(
	value: string | undefined,
	options: { authStorage: AuthStorage },
	config: ResolveGuildArgOptions = {},
): Promise<ResolvedDiscordGuildArg> {
	const guilds = await listDiscordGuilds(options);
	const trimmed = value?.trim();
	if (trimmed === undefined || trimmed.length === 0) {
		if (config.allowOmittedWhenSingleGuild === true && guilds.length === 1) {
			const guild = guilds[0];
			if (guild !== undefined) return guild;
		}
		throw new Error("Missing guild id or name.");
	}
	const byId = guilds.find((guild) => guild.id === trimmed);
	if (byId !== undefined) return byId;
	const normalized = trimmed.toLowerCase();
	const exactMatches = guilds.filter((guild) => guild.name.toLowerCase() === normalized);
	if (exactMatches.length === 1) {
		const match = exactMatches[0];
		if (match !== undefined) return match;
	}
	const partialMatches = guilds.filter((guild) => guild.name.toLowerCase().includes(normalized));
	if (partialMatches.length === 1) {
		const match = partialMatches[0];
		if (match !== undefined) return match;
	}
	if (partialMatches.length === 0) {
		throw new Error(`No visible Discord guild matched ${JSON.stringify(trimmed)}.`);
	}
	throw new Error(
		`Discord guild ${JSON.stringify(trimmed)} is ambiguous: ${partialMatches.map((guild) => `${guild.name} (${guild.id})`).join(", ")}`,
	);
}

function parseNumberFlag(value: string, label: string): number {
	const parsed = Number.parseInt(value, 10);
	if (!Number.isFinite(parsed)) throw new Error(`${label} must be a number.`);
	return parsed;
}

function requiredArg(value: string | undefined, label: string): string {
	if (value === undefined || value.trim().length === 0) throw new Error(`Missing ${label}.`);
	return value.trim();
}

function printDiscordHelp(): void {
	console.log(
		[
			"Usage: clanky discord [--profile <name>] [--home <dir>] <command>",
			"",
			"Commands:",
			"  guilds",
			"  channels <guild-id-or-name> [--since <24h|7d|ISO>]",
			"  messages <channel-id> [--limit <1-100>] [--since <24h|7d|ISO>] [--until <ISO>]",
			"  recent [guild-id-or-name] [--since <24h|7d|ISO>] [--channels <n>] [--messages <n>] [--channel <name-fragment>]",
			"  digest [guild-id-or-name] [--since <24h|7d|ISO>] [--channels <n>] [--messages <n>] [--channel <name-fragment>]",
			"  send <channel-id> <message text> [--file <path> ...]",
			"  emojis <guild-id-or-name>",
			"  react <channel-id> <message-id> <unicode-or-custom-emoji>",
			"",
			"Custom emoji reactions use the reaction string from `emojis`, e.g. name:id or a:name:id.",
		].join("\n"),
	);
}
