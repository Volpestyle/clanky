import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { resolveClankyDataPath } from "./paths.ts";

export type McpTransportKind = "stdio" | "streamable-http" | "sse";

export interface McpServerConfig {
	type?: "stdio" | "http" | "streamable-http" | "sse";
	command?: string;
	args?: string[];
	cwd?: string;
	env?: Record<string, string>;
	url?: string;
	description?: string;
	allowedTools?: string[];
	disabled?: boolean;
}

export interface McpToolSummary {
	server: string;
	name: string;
	description?: string;
	inputSchema?: unknown;
	annotations?: unknown;
}

export interface McpServerStatus {
	server: string;
	type: McpTransportKind;
	command?: string;
	args: string[];
	cwd: string;
	url?: string;
	description?: string;
	allowedTools?: string[];
	disabled?: boolean;
	error?: string;
	tools?: McpToolSummary[];
}

interface ResolvedMcpServerConfig extends Omit<McpServerConfig, "type"> {
	type: McpTransportKind;
	args: string[];
	cwd: string;
	env: Record<string, string>;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const MCP_CHILD_ENV_ALLOWLIST = new Set([
	"APPDATA",
	"BUN_INSTALL",
	"CARGO_HOME",
	"COMSPEC",
	"ComSpec",
	"COREPACK_HOME",
	"DENO_INSTALL",
	"GEM_HOME",
	"GEM_PATH",
	"GOENV_ROOT",
	"GOPATH",
	"GOROOT",
	"HOME",
	"HOMEBREW_PREFIX",
	"JAVA_HOME",
	"LANG",
	"LOCALAPPDATA",
	"LOGNAME",
	"MISE_DATA_DIR",
	"NVM_DIR",
	"PATH",
	"PATHEXT",
	"PNPM_HOME",
	"PYENV_ROOT",
	"RBENV_ROOT",
	"RUSTUP_HOME",
	"SHELL",
	"SystemRoot",
	"TEMP",
	"TERM",
	"TMP",
	"TMPDIR",
	"USER",
	"USERNAME",
	"VOLTA_HOME",
	"XDG_CACHE_HOME",
	"XDG_CONFIG_HOME",
	"XDG_DATA_HOME",
	"XDG_RUNTIME_DIR",
]);

export async function listMcpTools(input: { server?: string; timeoutMs?: number } = {}): Promise<McpServerStatus[]> {
	const configs = await resolveMcpServerConfigs();
	const selected = input.server === undefined ? Object.keys(configs) : [input.server];
	const statuses: McpServerStatus[] = [];
	for (const server of selected) {
		const config = configs[server];
		if (config === undefined) {
			statuses.push({ server, type: "stdio", args: [], cwd: process.cwd(), error: `Unknown MCP server: ${server}` });
			continue;
		}
		statuses.push(await listServerTools(server, config, input.timeoutMs));
	}
	return statuses;
}

export async function callMcpTool(input: {
	server: string;
	tool: string;
	arguments?: Record<string, unknown>;
	timeoutMs?: number;
}): Promise<unknown> {
	const configs = await resolveMcpServerConfigs();
	const config = configs[input.server];
	if (config === undefined) throw new Error(`Unknown MCP server: ${input.server}`);
	if (config.disabled === true) throw new Error(`MCP server is disabled: ${input.server}`);
	if (config.allowedTools !== undefined && !config.allowedTools.includes(input.tool)) {
		throw new Error(`Tool ${input.tool} is not allowed for MCP server ${input.server}`);
	}
	return await withMcpClient(input.server, config, input.timeoutMs, async (client) => {
		return await client.callTool({ name: input.tool, arguments: input.arguments ?? {} });
	});
}

export async function upsertMcpServer(name: string, config: McpServerConfig): Promise<{ path: string; servers: Record<string, McpServerConfig> }> {
	const path = resolveMcpServersPath();
	const servers = await readMcpServerStore();
	servers[name] = normalizeMcpServerConfig(name, config, "mcp_configure");
	await mkdir(dirname(path), { recursive: true, mode: 0o700 });
	await writeFile(path, `${JSON.stringify({ mcpServers: servers }, null, "\t")}\n`, { mode: 0o600 });
	return { path, servers };
}

async function resolveMcpServerConfigs(): Promise<Record<string, ResolvedMcpServerConfig>> {
	const configs: Record<string, McpServerConfig> = {
		...(await readMcpServerStore()),
		...parseEnvMcpServers(process.env.CLANKY_MCP_SERVERS),
	};
	return Object.fromEntries(
		Object.entries(configs).map(([name, config]) => [name, resolveServerConfig(normalizeMcpServerConfig(name, config))]),
	);
}

async function readMcpServerStore(): Promise<Record<string, McpServerConfig>> {
	try {
		const raw = await readFile(resolveMcpServersPath(), "utf8");
		return parseMcpConfigObject(JSON.parse(raw) as unknown, resolveMcpServersPath());
	} catch (error) {
		if (typeof error === "object" && error !== null && (error as { code?: unknown }).code === "ENOENT") return {};
		throw error;
	}
}

function resolveMcpServersPath(): string {
	return resolveClankyDataPath("mcp-servers.json");
}

async function listServerTools(
	server: string,
	config: ResolvedMcpServerConfig,
	timeoutMs: number | undefined,
): Promise<McpServerStatus> {
	const status = statusBase(server, config);
	if (config.disabled === true) return status;
	try {
		const tools = await withMcpClient(server, config, timeoutMs, async (client) => {
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
		return { ...status, tools };
	} catch (error) {
		return { ...status, error: error instanceof Error ? error.message : String(error) };
	}
}

async function withMcpClient<T>(
	server: string,
	config: ResolvedMcpServerConfig,
	timeoutMs: number | undefined,
	fn: (client: Client) => Promise<T>,
): Promise<T> {
	const transport = createTransport(config);
	const client = new Client({ name: "clanky", version: "0.1.0" });
	const timeout = new Promise<never>((_resolve, reject) => {
		const timer = setTimeout(
			() => reject(new Error(`MCP server ${server} timed out after ${timeoutMs ?? DEFAULT_TIMEOUT_MS}ms`)),
			timeoutMs ?? DEFAULT_TIMEOUT_MS,
		);
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
	if (config.type === "stdio") {
		if (config.command === undefined) throw new Error("stdio MCP server requires command");
		return new StdioClientTransport({
			command: config.command,
			args: config.args,
			cwd: config.cwd,
			env: config.env,
			stderr: "pipe",
		});
	}
	if (config.url === undefined) throw new Error(`${config.type} MCP server requires url`);
	if (config.type === "sse") return new SSEClientTransport(new URL(config.url)) as unknown as Transport;
	return new StreamableHTTPClientTransport(new URL(config.url)) as unknown as Transport;
}

function statusBase(server: string, config: ResolvedMcpServerConfig): McpServerStatus {
	return {
		server,
		type: config.type,
		args: config.args,
		cwd: config.cwd,
		...(config.command === undefined ? {} : { command: config.command }),
		...(config.url === undefined ? {} : { url: config.url }),
		...(config.description === undefined ? {} : { description: config.description }),
		...(config.allowedTools === undefined ? {} : { allowedTools: config.allowedTools }),
		...(config.disabled === undefined ? {} : { disabled: config.disabled }),
	};
}

function parseEnvMcpServers(raw: string | undefined): Record<string, McpServerConfig> {
	if (raw === undefined || raw.trim().length === 0) return {};
	return parseMcpConfigObject(JSON.parse(raw) as unknown, "CLANKY_MCP_SERVERS");
}

function parseMcpConfigObject(parsed: unknown, source: string): Record<string, McpServerConfig> {
	if (!isRecord(parsed)) throw new Error(`${source} must be a JSON object`);
	const rawServers = isRecord(parsed.mcpServers) ? parsed.mcpServers : parsed;
	return Object.fromEntries(
		Object.entries(rawServers).map(([name, value]) => {
			if (!isRecord(value)) throw new Error(`${source}.${name} must be an object`);
			return [name, normalizeMcpServerConfig(name, value, source)];
		}),
	);
}

function normalizeMcpServerConfig(name: string, config: McpServerConfig | Record<string, unknown>, source = "MCP config"): McpServerConfig {
	const command = stringAt(config, "command");
	const url = stringAt(config, "url");
	const type = parseTransportKind(stringAt(config, "type"), { command, url });
	if (type === undefined) throw new Error(`${source}.${name}.type must be stdio, http, streamable-http, or sse`);
	if (type === "stdio" && command === undefined) throw new Error(`${source}.${name}.command is required for stdio MCP`);
	if (type !== "stdio" && url === undefined) throw new Error(`${source}.${name}.url is required for HTTP/SSE MCP`);
	// Preserve an explicit empty allowedTools (deny-all) distinct from an omitted
	// one (unrestricted): listServerTools/callMcpTool treat undefined as no limit,
	// so dropping `[]` would silently turn a deny-all into allow-all.
	const allowedToolsRaw = (config as Record<string, unknown>).allowedTools;
	const allowedTools = Array.isArray(allowedToolsRaw)
		? allowedToolsRaw.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
		: undefined;
	return {
		type,
		...(command === undefined ? {} : { command }),
		...stringArrayProp(config, "args"),
		...stringProp(config, "cwd"),
		...stringRecordProp(config, "env"),
		...(url === undefined ? {} : { url }),
		...stringProp(config, "description"),
		...(allowedTools === undefined ? {} : { allowedTools }),
		...booleanProp(config, "disabled"),
	};
}

function resolveServerConfig(config: McpServerConfig): ResolvedMcpServerConfig {
	const type = parseTransportKind(config.type, { command: config.command, url: config.url });
	if (type === undefined) throw new Error("MCP server type could not be resolved");
	return {
		...config,
		type,
		args: config.args ?? [],
		cwd: config.cwd === undefined ? process.cwd() : resolve(process.cwd(), config.cwd),
		env: buildMcpStdioEnv(config.env),
	};
}

export function buildMcpStdioEnv(
	serverEnv: Record<string, string> | undefined = undefined,
	parentEnv: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [key, value] of Object.entries(parentEnv)) {
		if (value !== undefined && isAllowedMcpChildEnvKey(key)) out[key] = value;
	}
	return { ...out, ...(serverEnv ?? {}) };
}

function isAllowedMcpChildEnvKey(key: string): boolean {
	return MCP_CHILD_ENV_ALLOWLIST.has(key) || key.startsWith("LC_");
}

function parseTransportKind(
	value: string | undefined,
	input: { command?: string; url?: string },
): McpTransportKind | undefined {
	if (value === "stdio") return "stdio";
	if (value === "http" || value === "streamable-http") return "streamable-http";
	if (value === "sse") return "sse";
	if (value !== undefined) return undefined;
	if (input.command !== undefined) return "stdio";
	if (input.url !== undefined) return "streamable-http";
	return undefined;
}

function stringAt(value: Record<string, unknown> | McpServerConfig, key: string): string | undefined {
	const entry = value[key as keyof typeof value];
	return typeof entry === "string" && entry.trim().length > 0 ? entry.trim() : undefined;
}

function stringProp<T extends string>(value: Record<string, unknown> | McpServerConfig, key: T): { [K in T]?: string } {
	const entry = stringAt(value, key);
	return entry === undefined ? {} : ({ [key]: entry } as { [K in T]?: string });
}

function stringArrayProp<T extends string>(
	value: Record<string, unknown> | McpServerConfig,
	key: T,
): { [K in T]?: string[] } {
	const raw = value[key as keyof typeof value];
	const entries = Array.isArray(raw)
		? raw.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
		: [];
	return entries.length === 0 ? {} : ({ [key]: entries } as { [K in T]?: string[] });
}

function stringRecordProp<T extends string>(
	value: Record<string, unknown> | McpServerConfig,
	key: T,
): { [K in T]?: Record<string, string> } {
	const raw = value[key as keyof typeof value];
	if (!isRecord(raw) || !Object.values(raw).every((entry) => typeof entry === "string")) return {};
	return { [key]: raw } as { [K in T]?: Record<string, string> };
}

function booleanProp<T extends string>(value: Record<string, unknown> | McpServerConfig, key: T): { [K in T]?: boolean } {
	const entry = value[key as keyof typeof value];
	return typeof entry === "boolean" ? ({ [key]: entry } as { [K in T]?: boolean }) : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
