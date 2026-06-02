import {
	type AssistantMessage,
	type AssistantMessageDiagnostic,
	appendAssistantMessageDiagnostic,
} from "@earendil-works/pi-ai";
import {
	type AgentToolResult,
	defineTool,
	type ExtensionAPI,
	type ExtensionContext,
	type ExtensionFactory,
	type ToolInfo,
} from "@earendil-works/pi-coding-agent";
import { type TSchema, Type } from "typebox";
import {
	type ClankyMcpServerConfig,
	type ClankyMcpServerStatus,
	type ClankyMcpToolSummary,
	callExternalMcpTool,
	type ExternalMcpCallInput,
	type ExternalMcpClientOptions,
	listExternalMcpTools,
} from "./mcp/client.ts";
import { isRecord } from "./util/values.ts";

export type ToolSearchVariant = "bm25" | "regex";

export const TOOL_SEARCH_BM25_TYPE = "tool_search_tool_bm25_20251119";
export const TOOL_SEARCH_REGEX_TYPE = "tool_search_tool_regex_20251119";
export const TOOL_SEARCH_BM25_NAME = "tool_search_tool_bm25";
export const TOOL_SEARCH_REGEX_NAME = "tool_search_tool_regex";
export const TOOL_SEARCH_DIAGNOSTIC_TYPE = "clanky_tool_search";

export const DEFAULT_ALWAYS_LOADED_TOOLS: readonly string[] = ["read", "bash", "edit", "write", "mcp_call"];

export interface ToolSearchConfig {
	enabled: boolean;
	variant: ToolSearchVariant;
	alwaysLoadedTools: readonly string[];
}

export interface ToolSearchConfigOverrides {
	enabled?: boolean;
	variant?: ToolSearchVariant;
	alwaysLoadedTools?: readonly string[];
}

export interface ToolSearchFactoryOptions {
	env?: NodeJS.ProcessEnv;
	overrides?: ToolSearchConfigOverrides;
	mcpServers?: (ctx: ExtensionContext) => Record<string, ClankyMcpServerConfig>;
	mcpClientOptions?: ExternalMcpClientOptions;
	mcpToolStatuses?: (options: ExternalMcpClientOptions) => Promise<ClankyMcpServerStatus[]>;
	mcpToolCaller?: (input: ExternalMcpCallInput, options: ExternalMcpClientOptions) => Promise<unknown>;
}

interface AnthropicToolDefinition {
	name?: unknown;
	type?: unknown;
	input_schema?: unknown;
	defer_loading?: unknown;
	cache_control?: unknown;
	[key: string]: unknown;
}

interface AnthropicPayload {
	model?: unknown;
	messages?: unknown;
	tools?: unknown;
	stream?: unknown;
	max_tokens?: unknown;
	[key: string]: unknown;
}

interface AnthropicMessagesPayload extends AnthropicPayload {
	model: string;
	messages: unknown[];
	tools: unknown[];
	stream?: true;
	max_tokens: number;
}

export interface ToolSearchTelemetry {
	requestId: number;
	model: string;
	variant: ToolSearchVariant;
	totalTools: number;
	deferredTools: string[];
	loadedTools: string[];
	estimatedInputTokensBefore: number;
	estimatedInputTokensAfter: number;
	estimatedInputTokenDelta: number;
	toolSearchRequests?: number;
	toolSearchResultErrors: ToolSearchToolResultError[];
	discoveredToolReferences: string[];
}

export interface ToolSearchRewriteResult {
	payload: unknown;
	telemetry?: ToolSearchTelemetry;
}

export interface ToolSearchToolResultError {
	code: "too_many_requests" | "invalid_pattern" | "pattern_too_long" | "unavailable";
	message?: string;
}

const TOOL_SEARCH_RESULT_ERROR_CODES = new Set([
	"too_many_requests",
	"invalid_pattern",
	"pattern_too_long",
	"unavailable",
]);

const CHARS_PER_TOKEN = 4;
const MAX_TOOL_NAME_LENGTH = 64;
const RESPONSE_TELEMETRY_WAIT_MS = 100;

let nextRequestId = 1;
let fetchPatched = false;
let originalFetch: typeof fetch | undefined;
const pendingFetchTelemetry: ToolSearchTelemetry[] = [];

function parseEnabled(value: string | undefined): boolean | undefined {
	if (value === undefined) return undefined;
	const normalized = value.trim().toLowerCase();
	if (["1", "true", "yes", "on"].includes(normalized)) return true;
	if (["0", "false", "no", "off"].includes(normalized)) return false;
	return undefined;
}

function parseVariant(value: string | undefined): ToolSearchVariant | undefined {
	if (value === undefined) return undefined;
	const normalized = value.trim().toLowerCase();
	return normalized === "bm25" || normalized === "regex" ? normalized : undefined;
}

function parseNameList(value: string | undefined): string[] {
	if (value === undefined) return [];
	return value
		.split(",")
		.map((entry) => entry.trim())
		.filter((entry) => entry.length > 0);
}

export function resolveToolSearchConfig(options: ToolSearchFactoryOptions = {}): ToolSearchConfig {
	const env = options.env ?? process.env;
	const overrides = options.overrides ?? {};
	return {
		enabled: overrides.enabled ?? parseEnabled(env.CLANKY_TOOL_SEARCH) ?? false,
		variant: overrides.variant ?? parseVariant(env.CLANKY_TOOL_SEARCH_VARIANT) ?? "bm25",
		alwaysLoadedTools: overrides.alwaysLoadedTools ?? [
			...DEFAULT_ALWAYS_LOADED_TOOLS,
			...parseNameList(env.CLANKY_TOOL_SEARCH_ALWAYS_LOADED),
		],
	};
}

function toolSearchTool(config: ToolSearchConfig): AnthropicToolDefinition {
	return config.variant === "regex"
		? { type: TOOL_SEARCH_REGEX_TYPE, name: TOOL_SEARCH_REGEX_NAME }
		: { type: TOOL_SEARCH_BM25_TYPE, name: TOOL_SEARCH_BM25_NAME };
}

function isToolSearchTool(tool: AnthropicToolDefinition): boolean {
	return (
		tool.type === TOOL_SEARCH_BM25_TYPE ||
		tool.type === TOOL_SEARCH_REGEX_TYPE ||
		tool.name === TOOL_SEARCH_BM25_NAME ||
		tool.name === TOOL_SEARCH_REGEX_NAME
	);
}

function isAnthropicTool(tool: unknown): tool is AnthropicToolDefinition {
	return isRecord(tool) && typeof tool.name === "string" && isRecord(tool.input_schema);
}

function isAnthropicPayload(payload: unknown): payload is AnthropicMessagesPayload {
	if (!isRecord(payload)) return false;
	return (
		typeof payload.model === "string" &&
		Array.isArray(payload.messages) &&
		Array.isArray(payload.tools) &&
		(payload.stream === true || payload.stream === undefined) &&
		typeof payload.max_tokens === "number"
	);
}

function supportsAnthropicToolSearch(model: string): boolean {
	const normalized = model.toLowerCase();
	return (
		normalized.includes("claude-sonnet-4") ||
		normalized.includes("claude-opus-4") ||
		normalized.includes("claude-haiku-4-5")
	);
}

function estimateToolTokens(tool: AnthropicToolDefinition): number {
	return Math.ceil(JSON.stringify(tool).length / CHARS_PER_TOKEN);
}

function normalName(name: string): string {
	return name.toLowerCase();
}

function parseMcpToolName(toolName: string): { server: string; tool: string } | undefined {
	const match = /^mcp__([^_][^_]*)__([\s\S]+)$/.exec(toolName);
	if (match === null) return undefined;
	const [, server, tool] = match;
	if (server === undefined || tool === undefined) return undefined;
	return { server, tool };
}

function sanitizeMcpToolNameSegment(value: string): string {
	const sanitized = value
		.replace(/[^A-Za-z0-9_-]/g, "_")
		.replace(/_+/g, "_")
		.replace(/^_+|_+$/g, "");
	return sanitized.length > 0 ? sanitized : "tool";
}

function trimMcpDirectToolName(base: string, suffix: string): string {
	const maxBaseLength = MAX_TOOL_NAME_LENGTH - suffix.length;
	return `${base.slice(0, maxBaseLength).replace(/[_-]+$/g, "")}${suffix}`;
}

function mcpDirectToolName(server: string, tool: string, usedNames: Set<string>): string {
	const base = `mcp__${sanitizeMcpToolNameSegment(server)}__${sanitizeMcpToolNameSegment(tool)}`;
	let candidate = trimMcpDirectToolName(base, "");
	let suffix = 1;
	while (usedNames.has(candidate)) {
		const suffixText = `_${suffix++}`;
		candidate = trimMcpDirectToolName(base, suffixText);
	}
	usedNames.add(candidate);
	return candidate;
}

function parseMcpToolInfo(tool: ToolInfo | undefined): { server: string; tool: string } | undefined {
	if (tool === undefined) return undefined;
	const path = tool.sourceInfo.path;
	const fromName = parseMcpToolName(tool.name);
	if (fromName !== undefined) return fromName;
	if (tool.sourceInfo.source !== "mcp") return undefined;
	const match = /^mcp:([^:]+):(.+)$/.exec(path) ?? /^<mcp:([^:]+):(.+)>$/.exec(path);
	if (match === null) return undefined;
	const [, server, toolName] = match;
	if (server === undefined || toolName === undefined) return undefined;
	return { server, tool: toolName };
}

function mcpToolOverride(config: ClankyMcpServerConfig | undefined, tool: string): boolean | undefined {
	const override = config?.toolOverrides?.[tool];
	return override?.deferLoading;
}

function shouldDeferTool(input: {
	tool: AnthropicToolDefinition;
	toolInfo: ToolInfo | undefined;
	config: ToolSearchConfig;
	mcpServers: Record<string, ClankyMcpServerConfig>;
}): boolean {
	if (typeof input.tool.name !== "string") return false;
	const name = input.tool.name;
	if (isToolSearchTool(input.tool)) return false;
	if (input.config.alwaysLoadedTools.map(normalName).includes(normalName(name))) return false;

	const mcpTool = parseMcpToolInfo(input.toolInfo) ?? parseMcpToolName(name);
	if (mcpTool !== undefined) {
		const serverConfig = input.mcpServers[mcpTool.server];
		const override = mcpToolOverride(serverConfig, mcpTool.tool);
		if (override !== undefined) return override;
		if (serverConfig?.deferLoading !== undefined) return serverConfig.deferLoading;
	}

	return true;
}

function withoutDeferLoading(tool: AnthropicToolDefinition): AnthropicToolDefinition {
	const { defer_loading: _deferLoading, ...rest } = tool;
	return rest;
}

function withDeferLoading(tool: AnthropicToolDefinition, deferred: boolean): AnthropicToolDefinition {
	const base = withoutDeferLoading(tool);
	return deferred ? { ...base, defer_loading: true } : base;
}

function ensureLoadedTool(tools: AnthropicToolDefinition[]): AnthropicToolDefinition[] {
	if (tools.some((tool) => tool.defer_loading !== true && !isToolSearchTool(tool))) return tools;
	const index = tools.findIndex((tool) => !isToolSearchTool(tool));
	if (index === -1) return tools;
	const next = [...tools];
	const firstLoadedTool = next[index];
	if (firstLoadedTool === undefined) return tools;
	next[index] = withoutDeferLoading(firstLoadedTool);
	return next;
}

function buildToolInfoByName(tools: readonly ToolInfo[]): Map<string, ToolInfo> {
	const byName = new Map<string, ToolInfo>();
	for (const tool of tools) byName.set(tool.name, tool);
	return byName;
}

function mcpToolParameters(schema: unknown): TSchema {
	return isRecord(schema) ? (schema as unknown as TSchema) : Type.Object({});
}

function mcpToolDescription(tool: ClankyMcpToolSummary): string {
	const base =
		tool.description?.trim() || `Call MCP tool ${tool.name} from configured Clanky MCP server ${tool.server}.`;
	return `MCP ${tool.server}.${tool.name}: ${base}`;
}

function toolResult(details: unknown): AgentToolResult<unknown> {
	return {
		content: [{ type: "text", text: JSON.stringify(details ?? null, null, "\t") }],
		details,
	};
}

async function registerMcpToolWrappers(pi: ExtensionAPI, options: ToolSearchFactoryOptions): Promise<void> {
	if (options.mcpClientOptions === undefined && options.mcpToolStatuses === undefined) return;
	const mcpClientOptions = options.mcpClientOptions ?? {};
	const statuses =
		options.mcpToolStatuses !== undefined
			? await options.mcpToolStatuses(mcpClientOptions)
			: await listExternalMcpTools({}, mcpClientOptions);
	const callTool = options.mcpToolCaller ?? callExternalMcpTool;
	const usedNames = new Set<string>();

	for (const status of statuses) {
		if (status.disabled === true || status.tools === undefined) continue;
		for (const tool of status.tools) {
			const name = mcpDirectToolName(tool.server, tool.name, usedNames);
			pi.registerTool(
				defineTool({
					name,
					label: `${tool.server}.${tool.name}`,
					description: mcpToolDescription(tool),
					promptSnippet: `${name}: call ${tool.server}.${tool.name} from the configured MCP server.`,
					promptGuidelines: [
						"Use this direct MCP tool when its name and schema match the user's requested external action.",
						"Follow the source MCP server's policy and pass arguments matching the tool schema.",
					],
					parameters: mcpToolParameters(tool.inputSchema),
					async execute(_toolCallId, params) {
						return toolResult(
							await callTool({ server: tool.server, tool: tool.name, arguments: params }, mcpClientOptions),
						);
					},
				}),
			);
		}
	}
}

export function rewriteAnthropicToolSearchPayload(input: {
	payload: unknown;
	config: ToolSearchConfig;
	allTools?: readonly ToolInfo[];
	mcpServers?: Record<string, ClankyMcpServerConfig> | undefined;
}): ToolSearchRewriteResult {
	if (!input.config.enabled) return { payload: input.payload };
	if (!isAnthropicPayload(input.payload)) return { payload: input.payload };
	const model = input.payload.model;
	if (typeof model !== "string" || !supportsAnthropicToolSearch(model)) return { payload: input.payload };

	const tools = input.payload.tools.filter(isAnthropicTool);
	if (tools.length === 0) return { payload: input.payload };

	const toolInfoByName = buildToolInfoByName(input.allTools ?? []);
	const mcpServers = input.mcpServers ?? {};
	const rewrittenTools = tools.map((tool) => {
		const defer = shouldDeferTool({
			tool,
			toolInfo: typeof tool.name === "string" ? toolInfoByName.get(tool.name) : undefined,
			config: input.config,
			mcpServers,
		});
		return withDeferLoading(tool, defer);
	});
	const guardedTools = ensureLoadedTool(rewrittenTools);
	const searchTool = toolSearchTool(input.config);
	const finalTools = [searchTool, ...guardedTools.filter((tool) => !isToolSearchTool(tool))];

	const deferredTools = guardedTools
		.filter((tool) => tool.defer_loading === true && typeof tool.name === "string")
		.map((tool) => tool.name as string);
	const loadedTools = guardedTools
		.filter((tool) => tool.defer_loading !== true && typeof tool.name === "string")
		.map((tool) => tool.name as string);
	const estimatedInputTokensBefore = tools.reduce(
		(sum, tool) => sum + estimateToolTokens(withoutDeferLoading(tool)),
		0,
	);
	const estimatedInputTokensAfter =
		estimateToolTokens(searchTool) +
		guardedTools
			.filter((tool) => tool.defer_loading !== true)
			.reduce((sum, tool) => sum + estimateToolTokens(withoutDeferLoading(tool)), 0);

	return {
		payload: {
			...input.payload,
			tools: finalTools,
		},
		telemetry: {
			requestId: nextRequestId++,
			model,
			variant: input.config.variant,
			totalTools: tools.length,
			deferredTools,
			loadedTools,
			estimatedInputTokensBefore,
			estimatedInputTokensAfter,
			estimatedInputTokenDelta: Math.max(0, estimatedInputTokensBefore - estimatedInputTokensAfter),
			toolSearchResultErrors: [],
			discoveredToolReferences: [],
		},
	};
}

function readNumberPath(value: unknown, path: readonly string[]): number | undefined {
	let current = value;
	for (const key of path) {
		if (!isRecord(current)) return undefined;
		current = current[key];
	}
	return typeof current === "number" && Number.isFinite(current) ? current : undefined;
}

function responseToolSearchRequests(message: AssistantMessage): number | undefined {
	const usage = message.usage as unknown;
	return (
		readNumberPath(usage, ["server_tool_use", "tool_search_requests"]) ??
		readNumberPath(usage, ["serverToolUse", "toolSearchRequests"])
	);
}

function readToolSearchResultError(value: unknown): ToolSearchToolResultError | undefined {
	if (!isRecord(value)) return undefined;
	const rawCode = value.error_code ?? value.errorCode ?? value.code;
	if (typeof rawCode !== "string" || !TOOL_SEARCH_RESULT_ERROR_CODES.has(rawCode)) return undefined;
	const rawMessage = value.error_message ?? value.errorMessage ?? value.message;
	return {
		code: rawCode as ToolSearchToolResultError["code"],
		...(typeof rawMessage === "string" && rawMessage.length > 0 ? { message: rawMessage } : {}),
	};
}

function collectToolReferenceNames(value: unknown, names: Set<string>): void {
	if (Array.isArray(value)) {
		for (const entry of value) collectToolReferenceNames(entry, names);
		return;
	}
	if (!isRecord(value)) return;
	if (value.type === "tool_reference" && typeof value.name === "string") {
		names.add(value.name);
	}
	for (const entry of Object.values(value)) collectToolReferenceNames(entry, names);
}

interface SseDecodeState {
	event: string | null;
	data: string[];
}

function flushSseDecodeState(state: SseDecodeState): { event: string | null; data: string } | undefined {
	if (state.event === null && state.data.length === 0) return undefined;
	const event = { event: state.event, data: state.data.join("\n") };
	state.event = null;
	state.data = [];
	return event;
}

function decodeSseLine(line: string, state: SseDecodeState): { event: string | null; data: string } | undefined {
	if (line === "") return flushSseDecodeState(state);
	if (line.startsWith(":")) return undefined;
	const separator = line.indexOf(":");
	const key = separator === -1 ? line : line.slice(0, separator);
	const rawValue = separator === -1 ? "" : line.slice(separator + 1);
	const value = rawValue.startsWith(" ") ? rawValue.slice(1) : rawValue;
	if (key === "event") state.event = value;
	if (key === "data") state.data.push(value);
	return undefined;
}

function consumeLine(buffer: string): { line: string; rest: string } | undefined {
	const newline = buffer.search(/\r?\n/);
	if (newline === -1) return undefined;
	const line = buffer.slice(0, newline);
	const newlineLength = buffer[newline] === "\r" && buffer[newline + 1] === "\n" ? 2 : 1;
	return { line, rest: buffer.slice(newline + newlineLength) };
}

async function collectResponseTelemetry(body: ReadableStream<Uint8Array>): Promise<{
	toolSearchRequests?: number;
	toolSearchResultErrors: ToolSearchToolResultError[];
	discoveredToolReferences: string[];
}> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	const state: SseDecodeState = { event: null, data: [] };
	let buffer = "";
	let toolSearchRequests: number | undefined;
	const errors: ToolSearchToolResultError[] = [];
	const toolReferences = new Set<string>();

	const handleEvent = (event: { event: string | null; data: string } | undefined): void => {
		if (event === undefined || event.event === "error" || event.data.trim().length === 0) return;
		let parsed: unknown;
		try {
			parsed = JSON.parse(event.data);
		} catch {
			return;
		}
		const usageRequests =
			readNumberPath(parsed, ["usage", "server_tool_use", "tool_search_requests"]) ??
			readNumberPath(parsed, ["message", "usage", "server_tool_use", "tool_search_requests"]);
		if (usageRequests !== undefined) toolSearchRequests = usageRequests;
		if (isRecord(parsed) && parsed.type === "content_block_start") {
			const block = parsed.content_block;
			if (isRecord(block) && block.type === "tool_search_tool_result") {
				const error = readToolSearchResultError(block);
				if (error !== undefined) errors.push(error);
				collectToolReferenceNames(block, toolReferences);
			}
		}
	};

	try {
		while (true) {
			const { value, done } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });
			let consumed = consumeLine(buffer);
			while (consumed !== undefined) {
				buffer = consumed.rest;
				handleEvent(decodeSseLine(consumed.line, state));
				consumed = consumeLine(buffer);
			}
		}
		buffer += decoder.decode();
		let consumed = consumeLine(buffer);
		while (consumed !== undefined) {
			buffer = consumed.rest;
			handleEvent(decodeSseLine(consumed.line, state));
			consumed = consumeLine(buffer);
		}
		if (buffer.length > 0) handleEvent(decodeSseLine(buffer, state));
		handleEvent(flushSseDecodeState(state));
	} finally {
		reader.releaseLock();
	}

	return {
		...(toolSearchRequests !== undefined ? { toolSearchRequests } : {}),
		toolSearchResultErrors: errors,
		discoveredToolReferences: [...toolReferences],
	};
}

function isToolSearchRequestBody(text: string | undefined): boolean {
	if (text === undefined || !text.includes("tool_search_tool_")) return false;
	try {
		const parsed = JSON.parse(text) as unknown;
		if (!isRecord(parsed) || !Array.isArray(parsed.tools)) return false;
		return parsed.tools.some((tool) => isRecord(tool) && isToolSearchTool(tool));
	} catch {
		return false;
	}
}

async function readFetchBody(input: RequestInfo | URL, init?: RequestInit): Promise<string | undefined> {
	if (typeof init?.body === "string") return init.body;
	if (input instanceof Request) {
		try {
			return await input.clone().text();
		} catch {
			return undefined;
		}
	}
	return undefined;
}

function applyResponseTelemetry(telemetry: {
	toolSearchRequests?: number;
	toolSearchResultErrors: ToolSearchToolResultError[];
	discoveredToolReferences: string[];
}): void {
	const pending = pendingFetchTelemetry.find((entry) => entry.toolSearchRequests === undefined);
	if (pending === undefined) return;
	if (telemetry.toolSearchRequests !== undefined) pending.toolSearchRequests = telemetry.toolSearchRequests;
	pending.toolSearchResultErrors.push(...telemetry.toolSearchResultErrors);
	pending.discoveredToolReferences.push(...telemetry.discoveredToolReferences);
}

export function installToolSearchFetchTelemetry(): void {
	if (fetchPatched || typeof fetch !== "function") return;
	originalFetch = fetch.bind(globalThis);
	fetchPatched = true;
	globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const bodyText = await readFetchBody(input, init);
		const shouldObserve = isToolSearchRequestBody(bodyText);
		const response = await originalFetch?.(input, init);
		if (response === undefined || !shouldObserve || response.body === null) return response;
		const [providerBody, telemetryBody] = response.body.tee();
		void collectResponseTelemetry(telemetryBody)
			.then((telemetry) => applyResponseTelemetry(telemetry))
			.catch(() => undefined);
		return new Response(providerBody, {
			status: response.status,
			statusText: response.statusText,
			headers: response.headers,
		});
	}) as typeof fetch;
}

async function waitForResponseTelemetry(): Promise<void> {
	await new Promise<void>((resolve) => setTimeout(resolve, RESPONSE_TELEMETRY_WAIT_MS));
}

function buildDiagnostic(telemetry: ToolSearchTelemetry, message: AssistantMessage): AssistantMessageDiagnostic {
	const toolSearchRequests = responseToolSearchRequests(message) ?? telemetry.toolSearchRequests;
	return {
		type: TOOL_SEARCH_DIAGNOSTIC_TYPE,
		timestamp: Date.now(),
		details: {
			requestId: telemetry.requestId,
			model: telemetry.model,
			variant: telemetry.variant,
			totalTools: telemetry.totalTools,
			deferredToolCount: telemetry.deferredTools.length,
			loadedToolCount: telemetry.loadedTools.length,
			deferredTools: telemetry.deferredTools,
			loadedTools: telemetry.loadedTools,
			estimatedInputTokensBefore: telemetry.estimatedInputTokensBefore,
			estimatedInputTokensAfter: telemetry.estimatedInputTokensAfter,
			estimatedInputTokenDelta: telemetry.estimatedInputTokenDelta,
			...(toolSearchRequests !== undefined ? { toolSearchRequests } : {}),
			...(telemetry.toolSearchResultErrors.length > 0
				? { toolSearchResultErrors: telemetry.toolSearchResultErrors }
				: {}),
			...(telemetry.discoveredToolReferences.length > 0
				? { discoveredToolReferences: telemetry.discoveredToolReferences }
				: {}),
		},
	};
}

function isAssistantMessage(message: unknown): message is AssistantMessage {
	return isRecord(message) && message.role === "assistant" && Array.isArray(message.content) && isRecord(message.usage);
}

export function createToolSearchExtensionFactory(options: ToolSearchFactoryOptions = {}): ExtensionFactory {
	const config = resolveToolSearchConfig(options);
	return async (pi) => {
		if (!config.enabled) return;
		await registerMcpToolWrappers(pi, options);
		installToolSearchFetchTelemetry();
		const pendingTelemetry: ToolSearchTelemetry[] = [];

		pi.on("before_provider_request", (event, ctx) => {
			const result = rewriteAnthropicToolSearchPayload({
				payload: event.payload,
				config,
				allTools: pi.getAllTools(),
				mcpServers: options.mcpServers?.(ctx),
			});
			if (result.telemetry !== undefined) {
				pendingTelemetry.push(result.telemetry);
				pendingFetchTelemetry.push(result.telemetry);
			}
			return result.payload;
		});

		pi.on("message_end", async (event) => {
			if (!isAssistantMessage(event.message)) return undefined;
			const telemetry = pendingTelemetry.shift();
			if (telemetry === undefined) return undefined;
			await waitForResponseTelemetry();
			const index = pendingFetchTelemetry.indexOf(telemetry);
			if (index !== -1) pendingFetchTelemetry.splice(index, 1);
			appendAssistantMessageDiagnostic(event.message, buildDiagnostic(telemetry, event.message));
			return { message: event.message };
		});
	};
}
