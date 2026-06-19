import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { callMcpTool, listMcpTools, upsertMcpServer } from "../agent/lib/mcp.ts";

function assert(condition: boolean, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function textContent(result: unknown): string {
	if (!isRecord(result) || !Array.isArray(result.content)) throw new Error("MCP result did not include content");
	const first = result.content[0];
	if (!isRecord(first) || first.type !== "text" || typeof first.text !== "string") {
		throw new Error("MCP result did not include text content");
	}
	return first.text;
}

async function runFixtureServer(): Promise<void> {
	const server = new McpServer({
		name: "clanky-mcp-smoke",
		version: "0.1.0",
	});
	server.registerTool(
		"echo",
		{
			description: "Echo a message.",
			inputSchema: { message: z.string().min(1) },
		},
		({ message }) => ({
			content: [{ type: "text", text: `echo:${message}` }],
		}),
	);
	server.registerTool(
		"inspect_env",
		{
			description: "Report selected environment variables visible to the MCP subprocess.",
			inputSchema: {},
		},
		() => ({
			content: [
				{
					type: "text",
					text: JSON.stringify({
						PATH: process.env.PATH,
						HOME: process.env.HOME,
						CLANKY_TEST_ALLOWED: process.env.CLANKY_TEST_ALLOWED,
						DISCORD_BOT_TOKEN: process.env.DISCORD_BOT_TOKEN,
						OPENAI_API_KEY: process.env.OPENAI_API_KEY,
						CLANKY_RELAY_TOKEN: process.env.CLANKY_RELAY_TOKEN,
					}),
				},
			],
		}),
	);
	server.registerTool(
		"blocked",
		{
			description: "A tool that should be hidden by allowedTools.",
			inputSchema: {},
		},
		() => ({
			content: [{ type: "text", text: "blocked" }],
		}),
	);
	await server.connect(new StdioServerTransport());
}

async function runSmoke(): Promise<void> {
	const previousHome = process.env.CLANKY_HOME;
	const previousDiscordToken = process.env.DISCORD_BOT_TOKEN;
	const previousOpenAiApiKey = process.env.OPENAI_API_KEY;
	const previousRelayToken = process.env.CLANKY_RELAY_TOKEN;
	const home = await mkdtemp(join(tmpdir(), "clanky-mcp-stdio-"));
	try {
		process.env.CLANKY_HOME = home;
		process.env.DISCORD_BOT_TOKEN = "ambient-discord-secret";
		process.env.OPENAI_API_KEY = "ambient-openai-secret";
		process.env.CLANKY_RELAY_TOKEN = "ambient-relay-secret";
		const configured = await upsertMcpServer("minecraft", {
			type: "stdio",
			command: process.execPath,
			args: [new URL(import.meta.url).pathname, "server"],
			description: "Minecraft-style local MCP fixture",
			env: { CLANKY_TEST_ALLOWED: "explicit-server-env" },
			allowedTools: ["echo", "inspect_env"],
		});
		assert(configured.servers.minecraft?.command === process.execPath, "mcp_configure did not persist command");

		const statuses = await listMcpTools({ server: "minecraft", timeoutMs: 10_000 });
		const status = statuses[0];
		assert(status !== undefined, "mcp_list_tools returned no status");
		assert(status.error === undefined, `mcp_list_tools failed: ${status.error ?? ""}`);
		assert(status.tools?.some((tool) => tool.name === "echo") === true, "mcp_list_tools did not list echo");
		assert(status.tools?.some((tool) => tool.name === "inspect_env") === true, "mcp_list_tools did not list inspect_env");
		assert(status.tools?.some((tool) => tool.name === "blocked") === false, "mcp_list_tools exposed disallowed tool");

		const echo = await callMcpTool({
			server: "minecraft",
			tool: "echo",
			arguments: { message: "place torch" },
			timeoutMs: 10_000,
		});
		assert(textContent(echo) === "echo:place torch", "mcp_call did not return echo result");

		const envResult = await callMcpTool({
			server: "minecraft",
			tool: "inspect_env",
			timeoutMs: 10_000,
		});
		const childEnv = JSON.parse(textContent(envResult)) as unknown;
		assert(isRecord(childEnv), "inspect_env did not return an object");
		assert(childEnv.CLANKY_TEST_ALLOWED === "explicit-server-env", "mcp subprocess missed explicit server env");
		assert(childEnv.DISCORD_BOT_TOKEN === undefined, "mcp subprocess received ambient Discord token");
		assert(childEnv.OPENAI_API_KEY === undefined, "mcp subprocess received ambient OpenAI key");
		assert(childEnv.CLANKY_RELAY_TOKEN === undefined, "mcp subprocess received ambient relay token");

		let blocked = false;
		try {
			await callMcpTool({ server: "minecraft", tool: "blocked", timeoutMs: 10_000 });
		} catch (error) {
			blocked = error instanceof Error && error.message.includes("not allowed");
		}
		assert(blocked, "mcp_call allowed a blocked tool");
	} finally {
		if (previousHome === undefined) delete process.env.CLANKY_HOME;
		else process.env.CLANKY_HOME = previousHome;
		if (previousDiscordToken === undefined) delete process.env.DISCORD_BOT_TOKEN;
		else process.env.DISCORD_BOT_TOKEN = previousDiscordToken;
		if (previousOpenAiApiKey === undefined) delete process.env.OPENAI_API_KEY;
		else process.env.OPENAI_API_KEY = previousOpenAiApiKey;
		if (previousRelayToken === undefined) delete process.env.CLANKY_RELAY_TOKEN;
		else process.env.CLANKY_RELAY_TOKEN = previousRelayToken;
		await rm(home, { recursive: true, force: true });
	}
}

if (process.argv[2] === "server") {
	await runFixtureServer();
} else {
	await runSmoke();
}
