import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { ClankyPaths } from "../paths.ts";

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
	paths?: Pick<ClankyPaths, "mcpServersFile">;
}

export type ClankyMcpTransportKind = "stdio" | "http" | "streamable-http" | "sse";

export interface ClankyMcpServerConfig {
	type?: ClankyMcpTransportKind;
	command?: string;
	args?: string[];
	cwd?: string;
	env?: Record<string, string>;
	url?: string;
	description?: string;
	allowedTools?: string[];
	deferLoading?: boolean;
	toolOverrides?: Record<string, { deferLoading?: boolean }>;
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
	type: "stdio" | "streamable-http" | "sse";
	command?: string;
	args: string[];
	cwd: string;
	url?: string;
	description?: string;
	allowedTools?: string[];
	deferLoading?: boolean;
	toolOverrides?: Record<string, { deferLoading?: boolean }>;
	disabled?: boolean;
	error?: string;
	tools?: ClankyMcpToolSummary[];
}

interface ResolvedMcpServerConfig extends Omit<ClankyMcpServerConfig, "type"> {
	type: "stdio" | "streamable-http" | "sse";
	command?: string;
	args: string[];
	cwd: string;
	env: Record<string, string>;
	url?: string;
}

export interface ProfileMcpServerStore {
	path: string;
	servers: Record<string, ClankyMcpServerConfig>;
}

const DEFAULT_MCP_TIMEOUT_MS = 30_000;

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
				type: "stdio",
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

export function readProfileMcpServers(paths: Pick<ClankyPaths, "mcpServersFile">): ProfileMcpServerStore {
	try {
		const parsed = JSON.parse(readFileSync(paths.mcpServersFile, "utf8")) as unknown;
		return {
			path: paths.mcpServersFile,
			servers: parseMcpConfigObject(parsed, paths.mcpServersFile),
		};
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return { path: paths.mcpServersFile, servers: {} };
		}
		throw error;
	}
}

export function writeProfileMcpServers(
	paths: Pick<ClankyPaths, "mcpServersFile">,
	servers: Record<string, ClankyMcpServerConfig>,
): ProfileMcpServerStore {
	mkdirSync(dirname(paths.mcpServersFile), { recursive: true, mode: 0o700 });
	writeFileSync(paths.mcpServersFile, `${JSON.stringify({ mcpServers: servers }, null, 2)}\n`, {
		encoding: "utf8",
		mode: 0o600,
	});
	return { path: paths.mcpServersFile, servers };
}

export function upsertProfileMcpServer(
	paths: Pick<ClankyPaths, "mcpServersFile">,
	name: string,
	config: ClankyMcpServerConfig,
): ProfileMcpServerStore {
	const current = readProfileMcpServers(paths).servers;
	return writeProfileMcpServers(paths, { ...current, [name]: normalizeMcpServerConfig(name, config) });
}

export function removeProfileMcpServer(
	paths: Pick<ClankyPaths, "mcpServersFile">,
	name: string,
): ProfileMcpServerStore {
	const current = readProfileMcpServers(paths).servers;
	const { [name]: _removed, ...servers } = current;
	return writeProfileMcpServers(paths, servers);
}

export function resolveMcpServerConfigs(
	options: ExternalMcpClientOptions = {},
): Record<string, ResolvedMcpServerConfig> {
	const cwd = options.cwd ?? process.cwd();
	const env = options.env ?? process.env;
	const configs: Record<string, ResolvedMcpServerConfig> = {};

	if (options.paths !== undefined) {
		for (const [name, config] of Object.entries(readProfileMcpServers(options.paths).servers)) {
			configs[name] = resolveServerConfig(config, cwd, env);
		}
	}

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
				description:
					"AgentRoom room coordination: identity, roster, feed, channel/thread/DM messages, directed messages, events, posts, reports, waits, enroll, and audit context.",
				// No allowedTools: clanky exposes every tool the agentroom MCP server publishes so
				// its surface stays in lockstep with the live room. Restricting to a hardcoded subset
				// previously hid the roster/feed/directed-message tools the operator skill tells the
				// agent to use, yielding "tool not allowed" errors. The agentroom server is trusted.
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
		type: config.type,
		...(config.command === undefined ? {} : { command: config.command }),
		args: config.args,
		cwd: config.cwd,
		...(config.url === undefined ? {} : { url: config.url }),
		...(config.description === undefined ? {} : { description: config.description }),
		...(config.allowedTools === undefined ? {} : { allowedTools: config.allowedTools }),
		...(config.deferLoading === undefined ? {} : { deferLoading: config.deferLoading }),
		...(config.toolOverrides === undefined ? {} : { toolOverrides: config.toolOverrides }),
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
	const transport = createTransport(config);
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

function createTransport(config: ResolvedMcpServerConfig): Transport {
	switch (config.type) {
		case "stdio":
			if (config.command === undefined) throw new Error("stdio MCP server requires command");
			return new StdioClientTransport({
				command: config.command,
				args: config.args,
				cwd: config.cwd,
				env: config.env,
				stderr: "pipe",
			});
		case "sse":
			if (config.url === undefined) throw new Error("SSE MCP server requires url");
			return new SSEClientTransport(new URL(config.url)) as unknown as Transport;
		case "streamable-http":
			if (config.url === undefined) throw new Error("HTTP MCP server requires url");
			return new StreamableHTTPClientTransport(new URL(config.url)) as unknown as Transport;
	}
}

function parseEnvMcpServers(raw: string | undefined): Record<string, ClankyMcpServerConfig> {
	if (raw === undefined || raw.trim().length === 0) return {};
	const parsed = JSON.parse(raw) as unknown;
	return parseMcpConfigObject(parsed, "CLANKY_MCP_SERVERS");
}

function parseMcpConfigObject(parsed: unknown, source: string): Record<string, ClankyMcpServerConfig> {
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error(`${source} must be a JSON object keyed by server name.`);
	}
	const top = parsed as Record<string, unknown>;
	const rawServers =
		top.mcpServers !== undefined &&
		top.mcpServers !== null &&
		typeof top.mcpServers === "object" &&
		!Array.isArray(top.mcpServers)
			? (top.mcpServers as Record<string, unknown>)
			: top;
	const result: Record<string, ClankyMcpServerConfig> = {};
	for (const [name, value] of Object.entries(rawServers)) {
		if (value === null || typeof value !== "object" || Array.isArray(value)) {
			throw new Error(`${source}.${name} must be an object.`);
		}
		result[name] = normalizeMcpServerConfig(name, value as Record<string, unknown>, source);
	}
	return result;
}

function normalizeMcpServerConfig(
	name: string,
	config: ClankyMcpServerConfig | Record<string, unknown>,
	source = "MCP config",
): ClankyMcpServerConfig {
	const command = stringAt(config, "command");
	const url = stringAt(config, "url");
	const type = parseMcpTransportKind(stringAt(config, "type"), { command, url });
	if (type === undefined) {
		throw new Error(`${source}.${name}.type must be stdio, http, streamable-http, or sse.`);
	}
	if (type === "stdio" && command === undefined) {
		throw new Error(`${source}.${name}.command must be a non-empty string for stdio MCP.`);
	}
	if (type !== "stdio" && url === undefined) {
		throw new Error(`${source}.${name}.url must be a non-empty string for HTTP/SSE MCP.`);
	}
	return {
		type,
		...(command !== undefined ? { command } : {}),
		...stringArrayProp(config, "args"),
		...stringProp(config, "cwd"),
		...stringRecordProp(config, "env"),
		...(url !== undefined ? { url } : {}),
		...stringProp(config, "description"),
		...stringArrayProp(config, "allowedTools"),
		...booleanProp(config, "deferLoading"),
		...toolOverridesProp(config, "toolOverrides"),
		...booleanProp(config, "disabled"),
	};
}

function resolveServerConfig(
	config: ClankyMcpServerConfig,
	cwd: string,
	env: NodeJS.ProcessEnv,
): ResolvedMcpServerConfig {
	const type = parseMcpTransportKind(config.type, {
		command: config.command,
		url: config.url,
	});
	if (type === undefined) throw new Error("MCP server type could not be resolved.");
	return {
		...config,
		type,
		...(config.command === undefined ? {} : { command: config.command }),
		args: config.args ?? [],
		cwd: config.cwd === undefined ? cwd : resolve(cwd, config.cwd),
		env: {
			...definedEnv(env),
			...(config.env ?? {}),
		},
		...(config.url === undefined ? {} : { url: config.url }),
	};
}

function shouldAutoAddAgentRoom(env: NodeJS.ProcessEnv, cwd: string): boolean {
	if (env.CLANKY_AGENTROOM_MCP === "0" || env.CLANKY_AGENTROOM_MCP === "false") return false;
	return env.AGENTROOM === "1" || existsSync(`${env.AGENTROOM_CWD ?? cwd}/.agentroom/config.yaml`);
}

function parseMcpTransportKind(
	value: string | undefined,
	input: { command?: string | undefined; url?: string | undefined },
): "stdio" | "streamable-http" | "sse" | undefined {
	if (value === "stdio") return "stdio";
	if (value === "http" || value === "streamable-http") return "streamable-http";
	if (value === "sse") return "sse";
	if (value !== undefined) return undefined;
	if (input.command !== undefined) return "stdio";
	if (input.url !== undefined) return "streamable-http";
	return undefined;
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

function stringAt(value: Record<string, unknown> | ClankyMcpServerConfig, key: string): string | undefined {
	const entry = value[key as keyof typeof value];
	return typeof entry === "string" && entry.trim().length > 0 ? entry.trim() : undefined;
}

function stringProp<T extends string>(
	value: Record<string, unknown> | ClankyMcpServerConfig,
	key: T,
): { [K in T]?: string } {
	const entry = stringAt(value, key);
	return entry === undefined ? {} : ({ [key]: entry } as { [K in T]?: string });
}

function stringArrayProp<T extends string>(
	value: Record<string, unknown> | ClankyMcpServerConfig,
	key: T,
): { [K in T]?: string[] } {
	const raw = value[key as keyof typeof value];
	const entries = Array.isArray(raw)
		? raw.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
		: typeof raw === "string"
			? raw
					.split(/[,\s]+/)
					.map((entry) => entry.trim())
					.filter((entry) => entry.length > 0)
			: [];
	return entries.length === 0 ? {} : ({ [key]: entries } as { [K in T]?: string[] });
}

function stringRecordProp<T extends string>(
	value: Record<string, unknown> | ClankyMcpServerConfig,
	key: T,
): { [K in T]?: Record<string, string> } {
	const raw = value[key as keyof typeof value];
	return isStringRecord(raw) ? ({ [key]: raw } as { [K in T]?: Record<string, string> }) : {};
}

function booleanProp<T extends string>(
	value: Record<string, unknown> | ClankyMcpServerConfig,
	key: T,
): { [K in T]?: boolean } {
	const entry = value[key as keyof typeof value];
	return typeof entry === "boolean" ? ({ [key]: entry } as { [K in T]?: boolean }) : {};
}

function toolOverridesProp<T extends string>(
	value: Record<string, unknown> | ClankyMcpServerConfig,
	key: T,
): { [K in T]?: Record<string, { deferLoading?: boolean }> } {
	const raw = value[key as keyof typeof value];
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return {};
	const overrides: Record<string, { deferLoading?: boolean }> = {};
	for (const [toolName, override] of Object.entries(raw as Record<string, unknown>)) {
		if (override === null || typeof override !== "object" || Array.isArray(override)) continue;
		const deferLoading = (override as Record<string, unknown>).deferLoading;
		if (typeof deferLoading === "boolean") overrides[toolName] = { deferLoading };
	}
	return Object.keys(overrides).length === 0 ? {} : ({ [key]: overrides } as { [K in T]?: typeof overrides });
}

function definedEnv(env: NodeJS.ProcessEnv): Record<string, string> {
	const result: Record<string, string> = {};
	for (const [key, value] of Object.entries(env)) {
		if (value !== undefined) result[key] = value;
	}
	return result;
}
