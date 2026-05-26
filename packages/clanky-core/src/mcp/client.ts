import { existsSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

export interface ExternalMcpCallInput {
	server: string;
	tool: string;
	arguments?: unknown;
}

export interface ExternalMcpListToolsInput {
	server?: string;
}

export interface ExternalMcpClientOptions {
	cwd?: string;
	env?: NodeJS.ProcessEnv;
	timeoutMs?: number;
}

export interface ClankyMcpServerConfig {
	command: string;
	args?: string[];
	cwd?: string;
	env?: Record<string, string>;
	description?: string;
	allowedTools?: string[];
	disabled?: boolean;
}

export interface ClankyMcpToolSummary {
	server: string;
	name: string;
	description?: string;
	inputSchema?: unknown;
	annotations?: unknown;
}

export interface ClankyMcpServerStatus {
	server: string;
	command: string;
	args: string[];
	cwd: string;
	description?: string;
	allowedTools?: string[];
	disabled?: boolean;
	error?: string;
	tools?: ClankyMcpToolSummary[];
}

interface ResolvedMcpServerConfig extends ClankyMcpServerConfig {
	command: string;
	args: string[];
	cwd: string;
	env: Record<string, string>;
}

const DEFAULT_MCP_TIMEOUT_MS = 30_000;
const AGENTROOM_DEFAULT_TOOLS = [
	"agentroom_whoami",
	"agentroom_context",
	"agentroom_messages",
	"agentroom_events",
	"agentroom_post",
	"agentroom_dm",
	"agentroom_task",
	"agentroom_wait",
];

export async function listExternalMcpTools(
	input: ExternalMcpListToolsInput = {},
	options: ExternalMcpClientOptions = {},
): Promise<ClankyMcpServerStatus[]> {
	const configs = resolveMcpServerConfigs(options);
	const selected = input.server === undefined ? Object.keys(configs) : [input.server];
	const statuses: ClankyMcpServerStatus[] = [];

	for (const server of selected) {
		const config = configs[server];
		if (config === undefined) {
			statuses.push({
				server,
				command: "",
				args: [],
				cwd: options.cwd ?? process.cwd(),
				error: `Unknown MCP server: ${server}`,
			});
			continue;
		}
		statuses.push(await listServerTools(server, config, options));
	}

	return statuses;
}

export async function callExternalMcpTool(
	input: ExternalMcpCallInput,
	options: ExternalMcpClientOptions = {},
): Promise<unknown> {
	const configs = resolveMcpServerConfigs(options);
	const config = configs[input.server];
	if (config === undefined) throw new Error(`Unknown MCP server: ${input.server}`);
	if (config.disabled === true) throw new Error(`MCP server is disabled: ${input.server}`);
	if (config.allowedTools !== undefined && !config.allowedTools.includes(input.tool)) {
		throw new Error(`Tool ${input.tool} is not allowed for MCP server ${input.server}.`);
	}

	return await withMcpClient(input.server, config, options, async (client) => {
		return await client.callTool({
			name: input.tool,
			arguments: normalizeToolArguments(input.arguments),
		});
	});
}

export async function getExternalMcpStatus(options: ExternalMcpClientOptions = {}): Promise<ClankyMcpServerStatus[]> {
	return await listExternalMcpTools({}, options);
}

export function resolveMcpServerConfigs(
	options: ExternalMcpClientOptions = {},
): Record<string, ResolvedMcpServerConfig> {
	const cwd = options.cwd ?? process.cwd();
	const env = options.env ?? process.env;
	const configs: Record<string, ResolvedMcpServerConfig> = {};

	const envConfig = parseEnvMcpServers(env.CLANKY_MCP_SERVERS);
	for (const [name, config] of Object.entries(envConfig)) {
		configs[name] = resolveServerConfig(config, cwd, env);
	}

	if (shouldAutoAddAgentRoom(env, cwd) && configs.agentroom === undefined) {
		configs.agentroom = resolveServerConfig(
			{
				command: env.CLANKY_AGENTROOM_MCP_COMMAND ?? "agent-room",
				args: splitArgs(env.CLANKY_AGENTROOM_MCP_ARGS) ?? ["mcp"],
				cwd: env.AGENTROOM_CWD ?? cwd,
				description: "AgentRoom room coordination, messages, task shadows, waits, and audit context.",
				allowedTools: AGENTROOM_DEFAULT_TOOLS,
			},
			cwd,
			env,
		);
	}

	return configs;
}

async function listServerTools(
	server: string,
	config: ResolvedMcpServerConfig,
	options: ExternalMcpClientOptions,
): Promise<ClankyMcpServerStatus> {
	const statusBase = {
		server,
		command: config.command,
		args: config.args,
		cwd: config.cwd,
		...(config.description === undefined ? {} : { description: config.description }),
		...(config.allowedTools === undefined ? {} : { allowedTools: config.allowedTools }),
		...(config.disabled === undefined ? {} : { disabled: config.disabled }),
	};
	if (config.disabled === true) return statusBase;

	try {
		const tools = await withMcpClient(server, config, options, async (client) => {
			const result = await client.listTools();
			return result.tools
				.filter((tool) => config.allowedTools === undefined || config.allowedTools.includes(tool.name))
				.map((tool) => ({
					server,
					name: tool.name,
					...(tool.description === undefined ? {} : { description: tool.description }),
					...(tool.inputSchema === undefined ? {} : { inputSchema: tool.inputSchema }),
					...(tool.annotations === undefined ? {} : { annotations: tool.annotations }),
				}));
		});
		return { ...statusBase, tools };
	} catch (error) {
		return {
			...statusBase,
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

async function withMcpClient<T>(
	server: string,
	config: ResolvedMcpServerConfig,
	options: ExternalMcpClientOptions,
	fn: (client: Client) => Promise<T>,
): Promise<T> {
	const transport = new StdioClientTransport({
		command: config.command,
		args: config.args,
		cwd: config.cwd,
		env: config.env,
		stderr: "pipe",
	});
	const client = new Client({
		name: "clanky",
		version: "0.1.0",
	});
	const timeoutMs = options.timeoutMs ?? DEFAULT_MCP_TIMEOUT_MS;
	const timeout = new Promise<never>((_resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`MCP server ${server} timed out after ${timeoutMs}ms`)), timeoutMs);
		timer.unref?.();
	});

	try {
		return await Promise.race([
			(async () => {
				await client.connect(transport);
				return await fn(client);
			})(),
			timeout,
		]);
	} finally {
		await client.close().catch(() => undefined);
	}
}

function parseEnvMcpServers(raw: string | undefined): Record<string, ClankyMcpServerConfig> {
	if (raw === undefined || raw.trim().length === 0) return {};
	const parsed = JSON.parse(raw) as unknown;
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error("CLANKY_MCP_SERVERS must be a JSON object keyed by server name.");
	}
	const result: Record<string, ClankyMcpServerConfig> = {};
	for (const [name, value] of Object.entries(parsed)) {
		if (value === null || typeof value !== "object" || Array.isArray(value)) {
			throw new Error(`CLANKY_MCP_SERVERS.${name} must be an object.`);
		}
		const config = value as Record<string, unknown>;
		if (typeof config.command !== "string" || config.command.trim().length === 0) {
			throw new Error(`CLANKY_MCP_SERVERS.${name}.command must be a non-empty string.`);
		}
		result[name] = {
			command: config.command,
			...(Array.isArray(config.args)
				? { args: config.args.filter((arg): arg is string => typeof arg === "string") }
				: {}),
			...(typeof config.cwd === "string" ? { cwd: config.cwd } : {}),
			...(isStringRecord(config.env) ? { env: config.env } : {}),
			...(typeof config.description === "string" ? { description: config.description } : {}),
			...(Array.isArray(config.allowedTools)
				? { allowedTools: config.allowedTools.filter((tool): tool is string => typeof tool === "string") }
				: {}),
			...(typeof config.disabled === "boolean" ? { disabled: config.disabled } : {}),
		};
	}
	return result;
}

function resolveServerConfig(
	config: ClankyMcpServerConfig,
	cwd: string,
	env: NodeJS.ProcessEnv,
): ResolvedMcpServerConfig {
	return {
		...config,
		command: config.command,
		args: config.args ?? [],
		cwd: config.cwd ?? cwd,
		env: {
			...definedEnv(env),
			...(config.env ?? {}),
		},
	};
}

function shouldAutoAddAgentRoom(env: NodeJS.ProcessEnv, cwd: string): boolean {
	if (env.CLANKY_AGENTROOM_MCP === "0" || env.CLANKY_AGENTROOM_MCP === "false") return false;
	return env.AGENTROOM === "1" || existsSync(`${env.AGENTROOM_CWD ?? cwd}/.agentroom/config.yaml`);
}

function normalizeToolArguments(args: unknown): Record<string, unknown> {
	if (args === undefined || args === null) return {};
	if (typeof args === "object" && !Array.isArray(args)) return args as Record<string, unknown>;
	throw new Error("mcp_call arguments must be a JSON object when provided.");
}

function splitArgs(raw: string | undefined): string[] | undefined {
	if (raw === undefined || raw.trim().length === 0) return undefined;
	return raw.split(/\s+/).filter((arg) => arg.length > 0);
}

function isStringRecord(value: unknown): value is Record<string, string> {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
	return Object.values(value).every((entry) => typeof entry === "string");
}

function definedEnv(env: NodeJS.ProcessEnv): Record<string, string> {
	const result: Record<string, string> = {};
	for (const [key, value] of Object.entries(env)) {
		if (value !== undefined) result[key] = value;
	}
	return result;
}
