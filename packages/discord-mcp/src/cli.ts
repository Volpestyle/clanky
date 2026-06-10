#!/usr/bin/env node
import {
	addDiscordReaction,
	type DiscordCredentialKind,
	getDiscordIdentity,
	listDiscordChannels,
	listDiscordEmojis,
	listDiscordGuilds,
	readDiscordMessages,
	recentDiscordActivity,
	recentDiscordAttachments,
	removeStoredDiscordCredential,
	saveStoredDiscordCredential,
	sendDiscordMessage,
} from "./operator.ts";
import { dropUndefined } from "./util.ts";

type Args = Record<string, string | boolean | string[]>;

const TOOL_CALLS = {
	discord_whoami: async (_input: unknown) => await getDiscordIdentity(),
	discord_list_guilds: async (_input: unknown) => await listDiscordGuilds(),
	discord_list_channels: async (input: unknown) =>
		await listDiscordChannels(asInput<Parameters<typeof listDiscordChannels>[0]>(input)),
	discord_read_messages: async (input: unknown) =>
		await readDiscordMessages(asInput<Parameters<typeof readDiscordMessages>[0]>(input)),
	discord_recent_activity: async (input: unknown) =>
		await recentDiscordActivity(asInput<Parameters<typeof recentDiscordActivity>[0]>(input)),
	discord_recent_attachments: async (input: unknown) =>
		await recentDiscordAttachments(asInput<Parameters<typeof recentDiscordAttachments>[0]>(input)),
	discord_send_message: async (input: unknown) =>
		await sendDiscordMessage(asInput<Parameters<typeof sendDiscordMessage>[0]>(input)),
	discord_list_emojis: async (input: unknown) =>
		await listDiscordEmojis(asInput<Parameters<typeof listDiscordEmojis>[0]>(input)),
	discord_add_reaction: async (input: unknown) =>
		await addDiscordReaction(asInput<Parameters<typeof addDiscordReaction>[0]>(input)),
} as const;

type ToolName = keyof typeof TOOL_CALLS;

export async function runDiscordCli(argv = process.argv.slice(2)): Promise<void> {
	const [command = "help", ...rest] = argv;
	if (command === "help" || command === "--help" || command === "-h") {
		printHelp();
		return;
	}

	const args = parseArgs(rest);
	switch (command) {
		case "login":
			await login(args);
			return;
		case "logout":
			writeJson(await removeStoredDiscordCredential());
			return;
		case "whoami":
			writeJson(await getDiscordIdentity());
			return;
		case "guilds":
			writeJson(await listDiscordGuilds());
			return;
		case "channels":
			writeJson(
				await listDiscordChannels(
					dropUndefined<Parameters<typeof listDiscordChannels>[0]>({
						guild_id: stringArg(args, "guild", "guild-id"),
						since: stringArg(args, "since"),
					}),
				),
			);
			return;
		case "messages":
			writeJson(
				await readDiscordMessages(
					dropUndefined<Parameters<typeof readDiscordMessages>[0]>({
						channel_id: requiredStringArg(args, "channel", "channel-id"),
						limit: numberArg(args, "limit"),
						before: stringArg(args, "before"),
						after: stringArg(args, "after"),
						around: stringArg(args, "around"),
						since: stringArg(args, "since"),
						until: stringArg(args, "until"),
					}),
				),
			);
			return;
		case "activity":
			writeJson(
				await recentDiscordActivity(
					dropUndefined<Parameters<typeof recentDiscordActivity>[0]>({
						guild_id: stringArg(args, "guild", "guild-id"),
						since: stringArg(args, "since"),
						limit_channels: numberArg(args, "limit-channels"),
						message_limit: numberArg(args, "message-limit"),
						include_messages: booleanArg(args, "include-messages"),
					}),
				),
			);
			return;
		case "attachments":
			writeJson(
				await recentDiscordAttachments(
					dropUndefined<Parameters<typeof recentDiscordAttachments>[0]>({
						channel_id: requiredStringArg(args, "channel", "channel-id"),
						message_id: stringArg(args, "message", "message-id"),
						message_limit: numberArg(args, "message-limit") ?? numberArg(args, "limit"),
						media_limit: numberArg(args, "media-limit"),
						load: booleanArg(args, "load"),
					}),
				),
			);
			return;
		case "send":
			writeJson(
				await sendDiscordMessage(
					dropUndefined<Parameters<typeof sendDiscordMessage>[0]>({
						channel_id: requiredStringArg(args, "channel", "channel-id"),
						content: stringArg(args, "content") ?? (await stdinIfRequested(args)),
						file_paths: stringArrayArg(args, "file"),
						reply_to_message_id: stringArg(args, "reply-to", "reply-to-message-id"),
					}),
				),
			);
			return;
		case "emojis":
			writeJson(await listDiscordEmojis({ guild_id: requiredStringArg(args, "guild", "guild-id") }));
			return;
		case "react":
			writeJson(
				await addDiscordReaction({
					channel_id: requiredStringArg(args, "channel", "channel-id"),
					message_id: requiredStringArg(args, "message", "message-id"),
					emoji: requiredStringArg(args, "emoji"),
				}),
			);
			return;
		case "call":
			await callTool(rest);
			return;
		default:
			throw new Error(`Unknown command "${command}". Run discord-mcp help.`);
	}
}

async function login(args: Args): Promise<void> {
	const token = stringArg(args, "token") ?? (await stdinIfRequested(args)) ?? process.env.DISCORD_MCP_TOKEN;
	if (token === undefined || token.trim().length === 0) {
		throw new Error("login requires --token, --stdin, or DISCORD_MCP_TOKEN.");
	}
	const credentialKind = parseCredentialKind(stringArg(args, "kind") ?? process.env.DISCORD_MCP_CREDENTIAL_KIND);
	const identity = await getDiscordIdentity({
		env: {
			...process.env,
			DISCORD_MCP_TOKEN: token,
			DISCORD_MCP_CREDENTIAL_KIND: credentialKind,
		},
	});
	writeJson(
		await saveStoredDiscordCredential(
			dropUndefined<Parameters<typeof saveStoredDiscordCredential>[0]>({
				token,
				credentialKind,
				identity,
			}),
		),
	);
}

async function callTool(rest: string[]): Promise<void> {
	const [tool, ...argRest] = rest;
	if (!isToolName(tool)) throw new Error(`call requires one of: ${Object.keys(TOOL_CALLS).join(", ")}`);
	const args = parseArgs(argRest);
	const input = await parseJsonInput(args);
	writeJson(await TOOL_CALLS[tool](input));
}

async function parseJsonInput(args: Args): Promise<unknown> {
	const json = stringArg(args, "json");
	if (json !== undefined) return JSON.parse(json) as unknown;
	if (hasFlag(args, "stdin")) {
		const input = await readStdin();
		return input.trim().length === 0 ? {} : (JSON.parse(input) as unknown);
	}
	return {};
}

function parseArgs(values: readonly string[]): Args {
	const output: Args = {};
	for (let index = 0; index < values.length; index++) {
		const value = values[index];
		if (value === undefined) continue;
		if (!value.startsWith("--")) continue;
		const key = value.slice(2);
		const next = values[index + 1];
		const item: string | boolean = next !== undefined && !next.startsWith("--") ? next : true;
		if (typeof item === "string") index += 1;
		const existing = output[key];
		if (existing === undefined) {
			output[key] = item;
		} else if (Array.isArray(existing)) {
			existing.push(String(item));
		} else {
			output[key] = [String(existing), String(item)];
		}
	}
	return output;
}

function stringArg(args: Args, ...names: string[]): string | undefined {
	for (const name of names) {
		const value = args[name];
		if (typeof value === "string" && value.trim().length > 0) return value.trim();
	}
	return undefined;
}

function requiredStringArg(args: Args, ...names: string[]): string {
	const value = stringArg(args, ...names);
	if (value === undefined) throw new Error(`Missing required --${names[0]}.`);
	return value;
}

function numberArg(args: Args, name: string): number | undefined {
	const value = stringArg(args, name);
	if (value === undefined) return undefined;
	const parsed = Number(value);
	if (!Number.isFinite(parsed)) throw new Error(`--${name} must be a number.`);
	return parsed;
}

function booleanArg(args: Args, name: string): boolean | undefined {
	const value = args[name];
	if (value === undefined) return undefined;
	if (value === true) return true;
	if (value === false) return false;
	if (typeof value === "string") return value !== "false" && value !== "0";
	return undefined;
}

function stringArrayArg(args: Args, name: string): string[] | undefined {
	const value = args[name];
	if (Array.isArray(value)) return value;
	if (typeof value === "string") return [value];
	return undefined;
}

function hasFlag(args: Args, name: string): boolean {
	return args[name] === true || args[name] === "true";
}

async function stdinIfRequested(args: Args): Promise<string | undefined> {
	if (!hasFlag(args, "stdin")) return undefined;
	return await readStdin();
}

async function readStdin(): Promise<string> {
	const chunks: Buffer[] = [];
	for await (const chunk of process.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
	return Buffer.concat(chunks).toString("utf8");
}

function asInput<T>(value: unknown): T {
	if (typeof value !== "object" || value === null || Array.isArray(value))
		throw new Error("JSON input must be an object.");
	return value as T;
}

function isToolName(value: string | undefined): value is ToolName {
	return value !== undefined && value in TOOL_CALLS;
}

function parseCredentialKind(value: string | undefined): DiscordCredentialKind {
	return value === "user-token" ? "user-token" : "bot-token";
}

function writeJson(value: unknown): void {
	process.stdout.write(`${JSON.stringify(value ?? null, null, "\t")}\n`);
}

function printHelp(): void {
	process.stdout.write(`discord-mcp

Usage:
  discord-mcp login --stdin [--kind bot-token|user-token]
  discord-mcp whoami
  discord-mcp guilds
  discord-mcp channels --guild <guild-id> [--since 24h]
  discord-mcp messages --channel <channel-id> [--limit 20] [--since 24h]
  discord-mcp activity [--guild <guild-id>] [--since 24h]
  discord-mcp attachments --channel <channel-id> [--message <message-id>] [--media-limit 4]
  discord-mcp send --channel <channel-id> --content "text"
  discord-mcp react --channel <channel-id> --message <message-id> --emoji <emoji>
  discord-mcp call discord_read_messages --json '{"channel_id":"...","limit":20}'

Credentials:
  Prefer DISCORD_MCP_TOKEN or discord-mcp login --stdin.
  Credential kind defaults to bot-token; use user-token only when you accept the account risk.
`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
	runDiscordCli().catch((error) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	});
}
