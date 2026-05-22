import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

export type ExternalMcpServerState = "booted" | "error";

export interface ExternalMcpServerConfig {
	name: string;
	command: string;
	args: string[];
	cwd: string;
	env: Record<string, string>;
}

export interface ExternalMcpToolSummary {
	name: string;
	description?: string;
}

export interface ExternalMcpServerStatus {
	name: string;
	state: ExternalMcpServerState;
	command: string;
	args: string[];
	cwd: string;
	tools: ExternalMcpToolSummary[];
	error?: string;
}

export interface ExternalMcpCallInput {
	server: string;
	tool: string;
	arguments?: unknown;
}

export interface ExternalMcpCallResult {
	server: string;
	tool: string;
	result: unknown;
}

interface ExternalMcpRuntime {
	config: ExternalMcpServerConfig;
	client: Client;
	transport?: StdioClientTransport;
	tools: ExternalMcpToolSummary[];
	error?: string;
}

export class ExternalMcpManager {
	private readonly configs: ExternalMcpServerConfig[];
	private readonly runtimes = new Map<string, ExternalMcpRuntime>();

	constructor(configs: ExternalMcpServerConfig[]) {
		this.configs = configs;
	}

	static fromEnv(options: { env?: NodeJS.ProcessEnv; cwd?: string } = {}): ExternalMcpManager {
		return new ExternalMcpManager(readExternalMcpConfigs(options.env ?? process.env, options.cwd ?? process.cwd()));
	}

	async start(): Promise<void> {
		for (const config of this.configs) {
			if (this.runtimes.has(config.name)) continue;
			const runtime: ExternalMcpRuntime = {
				config,
				client: new Client({ name: `clanky-${config.name}`, version: "0.0.0" }),
				tools: [],
			};
			this.runtimes.set(config.name, runtime);
			try {
				const transport = new StdioClientTransport({
					command: config.command,
					args: config.args,
					cwd: config.cwd,
					env: childEnvironment(config),
					stderr: "pipe",
				});
				await runtime.client.connect(transport);
				runtime.transport = transport;
				runtime.tools = await listToolSummaries(runtime.client);
			} catch (error) {
				runtime.error = error instanceof Error ? error.message : String(error);
				await runtime.transport?.close().catch(() => undefined);
				delete runtime.transport;
			}
		}
	}

	status(): ExternalMcpServerStatus[] {
		return this.configs.map((config) => {
			const runtime = this.runtimes.get(config.name);
			const tools = runtime?.tools ?? [];
			const base = {
				name: config.name,
				command: config.command,
				args: config.args,
				cwd: config.cwd,
				tools,
			};
			if (runtime?.error !== undefined) {
				return {
					...base,
					state: "error" as const,
					error: runtime.error,
				};
			}
			return {
				...base,
				state: "booted" as const,
			};
		});
	}

	async callTool(input: ExternalMcpCallInput): Promise<ExternalMcpCallResult> {
		const server = input.server.trim();
		const tool = input.tool.trim();
		if (server.length === 0) throw new Error("MCP server must be a non-empty string");
		if (tool.length === 0) throw new Error("MCP tool must be a non-empty string");
		const runtime = this.runtimes.get(server);
		if (runtime === undefined) throw new Error(`Unknown MCP server: ${server}`);
		if (runtime.error !== undefined) throw new Error(`MCP server ${server} failed to boot: ${runtime.error}`);
		if (runtime.transport === undefined) throw new Error(`MCP server ${server} is not connected`);
		const args = readArguments(input.arguments);
		const result = await runtime.client.callTool({ name: tool, arguments: args });
		return { server, tool, result: resultJson(result) };
	}

	async close(): Promise<void> {
		await Promise.all(
			[...this.runtimes.values()].map(async (runtime) => {
				await runtime.transport?.close().catch(() => undefined);
			}),
		);
		this.runtimes.clear();
	}
}

async function listToolSummaries(client: Client): Promise<ExternalMcpToolSummary[]> {
	const listed = await client.listTools();
	return listed.tools.map((tool) => {
		const summary: ExternalMcpToolSummary = { name: tool.name };
		if (tool.description !== undefined) summary.description = tool.description;
		return summary;
	});
}

function childEnvironment(config: ExternalMcpServerConfig): Record<string, string> {
	return {
		...getDefaultEnvironment(),
		...config.env,
	};
}

function readArguments(value: unknown): Record<string, unknown> {
	if (value === undefined) return {};
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error("MCP call arguments must be an object");
	}
	return value as Record<string, unknown>;
}

function readExternalMcpConfigs(env: NodeJS.ProcessEnv, defaultCwd: string): ExternalMcpServerConfig[] {
	const raw = normalizedEnv(env.CLANKY_MCP_SERVERS_JSON);
	if (raw === undefined) return [];
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw) as unknown;
	} catch {
		throw new Error("CLANKY_MCP_SERVERS_JSON must be valid JSON");
	}
	const configs = Array.isArray(parsed)
		? parsed.map((value) => readConfig(value, defaultCwd))
		: readConfigMap(parsed, defaultCwd);
	const names = new Set<string>();
	for (const config of configs) {
		if (names.has(config.name)) throw new Error(`Duplicate MCP server name: ${config.name}`);
		names.add(config.name);
	}
	return configs;
}

function readConfigMap(value: unknown, defaultCwd: string): ExternalMcpServerConfig[] {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error("CLANKY_MCP_SERVERS_JSON must be an array or object");
	}
	return Object.entries(value as Record<string, unknown>).map(([name, config]) => readConfig(config, defaultCwd, name));
}

function readConfig(value: unknown, defaultCwd: string, fallbackName?: string): ExternalMcpServerConfig {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error("MCP server config must be an object");
	}
	const candidate = value as Record<string, unknown>;
	const name = stringField(candidate.name, "MCP server name", fallbackName);
	const command = stringField(candidate.command, `MCP server ${name} command`);
	const args = stringArrayField(candidate.args, `MCP server ${name} args`);
	const cwd = stringField(candidate.cwd, `MCP server ${name} cwd`, defaultCwd);
	const env = envField(candidate.env, `MCP server ${name} env`);
	return { name, command, args, cwd, env };
}

function stringField(value: unknown, label: string, fallback?: string): string {
	const candidate = typeof value === "string" ? value : fallback;
	const trimmed = candidate?.trim();
	if (trimmed === undefined || trimmed.length === 0) throw new Error(`${label} must be a non-empty string`);
	return trimmed;
}

function stringArrayField(value: unknown, label: string): string[] {
	if (value === undefined) return [];
	if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
		throw new Error(`${label} must be a string array`);
	}
	return value;
}

function envField(value: unknown, label: string): Record<string, string> {
	if (value === undefined) return {};
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error(`${label} must be an object`);
	}
	const env: Record<string, string> = {};
	for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
		if (typeof item !== "string") throw new Error(`${label}.${key} must be a string`);
		env[key] = item;
	}
	return env;
}

function resultJson(value: unknown): unknown {
	const structuredContent = property(value, "structuredContent");
	if (structuredContent !== undefined) return structuredContent;
	const content = property(value, "content");
	if (!Array.isArray(content)) return value;
	const first = content[0];
	const text = property(first, "text");
	if (typeof text !== "string") return value;
	try {
		return JSON.parse(text) as unknown;
	} catch {
		return { text };
	}
}

function property(value: unknown, key: string): unknown {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	return (value as Record<string, unknown>)[key];
}

function normalizedEnv(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
}
