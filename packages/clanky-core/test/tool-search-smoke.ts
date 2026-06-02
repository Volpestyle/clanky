import {
	createToolSearchExtensionFactory,
	resolveToolSearchConfig,
	rewriteAnthropicToolSearchPayload,
	TOOL_SEARCH_BM25_NAME,
	TOOL_SEARCH_BM25_TYPE,
	TOOL_SEARCH_DIAGNOSTIC_TYPE,
	TOOL_SEARCH_REGEX_NAME,
	TOOL_SEARCH_REGEX_TYPE,
	type ToolSearchConfig,
} from "@clanky/core";
import type { AssistantMessage, AssistantMessageEvent, Context, Model } from "@earendil-works/pi-ai";
import { streamAnthropic } from "@earendil-works/pi-ai/anthropic";
import type {
	ExtensionContext,
	ExtensionFactory,
	SourceInfo,
	ToolDefinition,
	ToolInfo,
} from "@earendil-works/pi-coding-agent";

type Pi = Parameters<ExtensionFactory>[0];
type Handler = (event: { payload?: unknown; message?: unknown }, ctx: ExtensionContext) => unknown;

function assert(condition: boolean, message: string): void {
	if (!condition) throw new Error(`tool-search-smoke: ${message}`);
}

function sourceInfo(source: string, name: string, path = `<${source}:${name}>`): SourceInfo {
	return { path, source, scope: "user", origin: "top-level" };
}

function tool(name: string, source = "sdk", path?: string): ToolInfo {
	return {
		name,
		description: `${name} description`,
		parameters: { type: "object", properties: { value: { type: "string" } } },
		sourceInfo: sourceInfo(source, name, path),
	} as unknown as ToolInfo;
}

function anthropicTool(name: string): Record<string, unknown> {
	return {
		name,
		description: `${name} description`,
		input_schema: { type: "object", properties: { value: { type: "string" } }, required: [] },
	};
}

function payload(toolNames: string[], model = "claude-sonnet-4-20250514"): Record<string, unknown> {
	return {
		model,
		messages: [{ role: "user", content: "hi" }],
		max_tokens: 1024,
		stream: true,
		tools: toolNames.map(anthropicTool),
	};
}

function sse(events: Record<string, unknown>[]): string {
	return events
		.map((event) => {
			const type = typeof event.type === "string" ? event.type : "message";
			return `event: ${type}\ndata: ${JSON.stringify(event)}\n\n`;
		})
		.join("");
}

function toolByName(tools: unknown[], name: string): Record<string, unknown> {
	const found = tools.find(
		(entry) => typeof entry === "object" && entry !== null && (entry as { name?: unknown }).name === name,
	);
	assert(found !== undefined, `expected tool ${name}`);
	return found as Record<string, unknown>;
}

function createFakePi(allTools: ToolInfo[]): {
	pi: Pi;
	getHandler: (event: string) => Handler | undefined;
	registeredTools: ToolDefinition[];
} {
	const handlers = new Map<string, Handler>();
	const toolInfos = [...allTools];
	const registeredTools: ToolDefinition[] = [];
	const pi = {
		getAllTools: () => toolInfos,
		registerTool: (definition: ToolDefinition) => {
			registeredTools.push(definition);
			toolInfos.push({
				name: definition.name,
				description: definition.description,
				parameters: definition.parameters,
				promptGuidelines: definition.promptGuidelines,
				sourceInfo: sourceInfo("extension", definition.name),
			} as unknown as ToolInfo);
		},
		on: (event: string, handler: Handler) => {
			handlers.set(event, handler);
		},
	} as unknown as Pi;
	return { pi, getHandler: (event) => handlers.get(event), registeredTools };
}

const baseTools = [
	"read",
	"bash",
	"edit",
	"write",
	"mcp_call",
	"browser_click",
	"web_search",
	"openai_image_generate",
	"mcp__linear__search",
];

const allTools = [
	tool("read", "builtin"),
	tool("bash", "builtin"),
	tool("edit", "builtin"),
	tool("write", "builtin"),
	tool("mcp_call"),
	tool("browser_click"),
	tool("web_search"),
	tool("openai_image_generate"),
	tool("mcp__linear__search", "mcp", "mcp:linear:search"),
];

const toolSearchResultEvent = {
	type: "content_block_start",
	index: 0,
	content_block: {
		type: "tool_search_tool_result",
		tool_use_id: "srvu_1",
		content: [{ type: "tool_reference", name: "web_search" }],
		error_code: "invalid_pattern",
		message: "invalid search pattern",
	},
};

const messageDeltaWithToolSearchUsage = {
	type: "message_delta",
	delta: { stop_reason: "stop", stop_sequence: null },
	usage: {
		input_tokens: 3,
		output_tokens: 1,
		cache_read_input_tokens: 0,
		cache_creation_input_tokens: 0,
		server_tool_use: { tool_search_requests: 7 },
	},
};

// --- 1. Config defaults off, env enables server-side Anthropic tool search ---
{
	const defaults = resolveToolSearchConfig({ env: {} });
	assert(defaults.enabled === false, "tool search must default off");
	assert(defaults.variant === "bm25", "default variant must be bm25");

	const envConfig = resolveToolSearchConfig({
		env: { CLANKY_TOOL_SEARCH: "1", CLANKY_TOOL_SEARCH_VARIANT: "regex" },
	});
	assert(envConfig.enabled === true, "CLANKY_TOOL_SEARCH=1 must enable tool search");
	assert(envConfig.variant === "regex", "regex env variant must be honored");
}

// --- 2. Enabled rewrite prepends Anthropic search and defers non-hot tools ---
{
	const config: ToolSearchConfig = {
		...resolveToolSearchConfig({ env: {} }),
		enabled: true,
	};
	const result = rewriteAnthropicToolSearchPayload({
		payload: payload(baseTools),
		config,
		allTools,
		mcpServers: {
			linear: {
				type: "http",
				url: "https://mcp.linear.app/mcp",
				deferLoading: true,
				toolOverrides: { search: { deferLoading: false } },
			},
		},
	});
	const rewritten = result.payload as { tools: Record<string, unknown>[] };
	assert(rewritten.tools[0]?.type === TOOL_SEARCH_BM25_TYPE, "bm25 search tool must be first");
	assert(rewritten.tools[0]?.name === TOOL_SEARCH_BM25_NAME, "bm25 search tool name must match Anthropic spec");
	assert(toolByName(rewritten.tools, "read").defer_loading !== true, "read must stay loaded");
	assert(toolByName(rewritten.tools, "mcp_call").defer_loading !== true, "mcp_call must stay loaded");
	assert(toolByName(rewritten.tools, "browser_click").defer_loading === true, "browser_click must be deferred");
	assert(toolByName(rewritten.tools, "web_search").defer_loading === true, "web_search must be deferred");
	assert(
		toolByName(rewritten.tools, "mcp__linear__search").defer_loading !== true,
		"per-tool MCP deferLoading:false override must keep the tool loaded",
	);
	assert(result.telemetry?.deferredTools.includes("browser_click") === true, "telemetry must list deferred tools");
	assert(result.telemetry?.loadedTools.includes("mcp__linear__search") === true, "telemetry must list loaded tools");
	assert(
		(result.telemetry?.estimatedInputTokenDelta ?? 0) > 0,
		"telemetry must include an estimated input token delta",
	);
}

// --- 3. Regex variant uses the regex server-side search tool ---
{
	const result = rewriteAnthropicToolSearchPayload({
		payload: payload(["read", "browser_click"]),
		config: { enabled: true, variant: "regex", alwaysLoadedTools: ["read"] },
		allTools,
	});
	const rewritten = result.payload as { tools: Record<string, unknown>[] };
	assert(rewritten.tools[0]?.type === TOOL_SEARCH_REGEX_TYPE, "regex search tool type must match Anthropic spec");
	assert(rewritten.tools[0]?.name === TOOL_SEARCH_REGEX_NAME, "regex search tool name must match Anthropic spec");
}

// --- 4. Unsupported models and disabled config are no-ops ---
{
	const disabledPayload = payload(["read", "browser_click"]);
	const disabled = rewriteAnthropicToolSearchPayload({
		payload: disabledPayload,
		config: { enabled: false, variant: "bm25", alwaysLoadedTools: [] },
		allTools,
	});
	assert(disabled.payload === disabledPayload, "disabled config must leave payload unchanged");

	const unsupportedPayload = payload(["read", "browser_click"], "claude-3-5-sonnet-20241022");
	const unsupported = rewriteAnthropicToolSearchPayload({
		payload: unsupportedPayload,
		config: { enabled: true, variant: "bm25", alwaysLoadedTools: [] },
		allTools,
	});
	assert(unsupported.payload === unsupportedPayload, "unsupported Anthropic models must be skipped");
}

// --- 5. Guard keeps at least one non-deferred normal tool to avoid Anthropic 400s ---
{
	const result = rewriteAnthropicToolSearchPayload({
		payload: payload(["browser_click"]),
		config: { enabled: true, variant: "bm25", alwaysLoadedTools: [] },
		allTools,
	});
	const rewritten = result.payload as { tools: Record<string, unknown>[] };
	assert(toolByName(rewritten.tools, "browser_click").defer_loading !== true, "single normal tool must stay loaded");
	assert(result.telemetry?.loadedTools.includes("browser_click") === true, "guarded tool must be counted as loaded");
}

// --- 6. Enabled extension registers MCP-discovered tools as direct wrappers ---
{
	globalThis.fetch = (async () =>
		new Response(sse([messageDeltaWithToolSearchUsage, toolSearchResultEvent]), {
			status: 200,
			headers: { "content-type": "text/event-stream" },
		})) as typeof fetch;

	const mcpCalls: unknown[] = [];
	const { pi, getHandler, registeredTools } = createFakePi(allTools);
	const factory = createToolSearchExtensionFactory({
		env: {},
		overrides: { enabled: true, variant: "bm25", alwaysLoadedTools: ["read"] },
		mcpClientOptions: {},
		mcpToolStatuses: async () => [
			{
				server: "linear",
				type: "streamable-http",
				args: [],
				cwd: process.cwd(),
				url: "https://mcp.linear.app/mcp",
				deferLoading: true,
				toolOverrides: { search_issues: { deferLoading: false } },
				tools: [
					{
						server: "linear",
						name: "search_issues",
						description: "Search Linear issues.",
						inputSchema: {
							type: "object",
							properties: { query: { type: "string" } },
							required: ["query"],
						},
					},
				],
			},
		],
		mcpToolCaller: async (input) => {
			mcpCalls.push(input);
			return { ok: true };
		},
		mcpServers: () => ({
			linear: {
				type: "http",
				url: "https://mcp.linear.app/mcp",
				deferLoading: true,
				toolOverrides: { search_issues: { deferLoading: false } },
			},
		}),
	});
	await factory(pi);

	const directMcpTool = registeredTools.find((entry) => entry.name === "mcp__linear__search_issues");
	if (directMcpTool === undefined) {
		throw new Error("tool-search-smoke: direct MCP wrapper was not registered");
	}
	const ctx = { sessionManager: { getSessionId: () => "session-1" } } as unknown as ExtensionContext;
	await directMcpTool.execute("toolu_1", { query: "Tool Search" }, undefined, undefined, ctx);
	const firstCall = mcpCalls[0] as { server?: unknown; tool?: unknown; arguments?: unknown } | undefined;
	if (firstCall === undefined) throw new Error("tool-search-smoke: direct MCP wrapper did not call MCP client");
	assert(firstCall?.server === "linear", "direct MCP wrapper must call the original server");
	assert(firstCall?.tool === "search_issues", "direct MCP wrapper must call the original MCP tool");
	assert(
		(firstCall.arguments as { query?: unknown } | undefined)?.query === "Tool Search",
		"direct MCP wrapper must forward arguments",
	);

	const beforeProviderRequest = getHandler("before_provider_request");
	if (beforeProviderRequest === undefined)
		throw new Error("tool-search-smoke: before_provider_request handler missing");
	const rewritten = (await beforeProviderRequest(
		{ payload: payload(["read", "mcp__linear__search_issues"]) },
		ctx,
	)) as {
		tools: Record<string, unknown>[];
	};
	assert(
		toolByName(rewritten.tools, "mcp__linear__search_issues").defer_loading !== true,
		"per-tool MCP override must keep a direct MCP wrapper loaded",
	);
	const messageEnd = getHandler("message_end");
	if (messageEnd === undefined) throw new Error("tool-search-smoke: message_end handler missing");
	await messageEnd(
		{
			message: {
				role: "assistant",
				content: [{ type: "text", text: "done" }],
				api: "anthropic-messages",
				provider: "anthropic",
				model: "claude-sonnet-4-20250514",
				usage: {
					input: 10,
					output: 2,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 12,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: Date.now(),
			} as AssistantMessage,
		},
		{ sessionManager: { getSessionId: () => "session-1" } } as unknown as ExtensionContext,
	);
}

// --- 7. Extension records request telemetry and raw Anthropic response diagnostics ---
{
	const { pi, getHandler } = createFakePi(allTools);
	const factory = createToolSearchExtensionFactory({
		env: {},
		overrides: { enabled: true, variant: "bm25", alwaysLoadedTools: ["read"] },
	});
	await factory(pi);
	const beforeProviderRequest = getHandler("before_provider_request");
	const messageEnd = getHandler("message_end");
	if (beforeProviderRequest === undefined)
		throw new Error("tool-search-smoke: before_provider_request handler missing");
	if (messageEnd === undefined) throw new Error("tool-search-smoke: message_end handler missing");

	const ctx = {
		sessionManager: { getSessionId: () => "session-1" },
	} as unknown as ExtensionContext;
	const rewritten = (await beforeProviderRequest({ payload: payload(["read", "browser_click"]) }, ctx)) as {
		tools: Record<string, unknown>[];
	};
	assert(rewritten.tools[0]?.type === TOOL_SEARCH_BM25_TYPE, "extension must rewrite provider payload");
	const observedResponse = await fetch("https://api.anthropic.com/v1/messages", {
		method: "POST",
		body: JSON.stringify(rewritten),
	});
	await observedResponse.text();

	const message = {
		role: "assistant",
		content: [{ type: "text", text: "done" }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-20250514",
		usage: {
			input: 10,
			output: 2,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 12,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	} as AssistantMessage;
	await messageEnd({ message }, ctx);
	const diagnostic = message.diagnostics?.find((entry) => entry.type === TOOL_SEARCH_DIAGNOSTIC_TYPE);
	if (diagnostic === undefined) throw new Error("tool-search-smoke: message_end did not append diagnostic");
	assert(diagnostic.details?.toolSearchRequests === 7, "diagnostic must record raw usage.server_tool_use requests");
	assert(diagnostic.details?.deferredToolCount === 1, "diagnostic must include deferred count");
	assert(diagnostic.details?.loadedToolCount === 1, "diagnostic must include loaded count");
	const errors = diagnostic.details?.toolSearchResultErrors;
	assert(
		Array.isArray(errors) && errors.some((entry) => (entry as { code?: unknown }).code === "invalid_pattern"),
		"diagnostic must record 200-status tool_search_tool_result errors",
	);
	const discoveredTools = diagnostic.details?.discoveredToolReferences;
	assert(
		Array.isArray(discoveredTools) && discoveredTools.includes("web_search"),
		"diagnostic must record discovered tool references",
	);
}

// --- 8. Pi's Anthropic stream parser tolerates server-side search blocks ---
{
	const model = {
		id: "claude-sonnet-4-20250514",
		name: "Claude Sonnet 4",
		api: "anthropic-messages",
		provider: "anthropic",
		baseUrl: "https://api.anthropic.com",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200000,
		maxTokens: 8192,
	} satisfies Model<"anthropic-messages">;
	const context = {
		messages: [{ role: "user", content: "find the browser click tool", timestamp: Date.now() }],
	} satisfies Context;
	const fakeClient = {
		messages: {
			create: () => ({
				asResponse: async () =>
					new Response(
						sse([
							{
								type: "message_start",
								message: {
									id: "msg_1",
									usage: {
										input_tokens: 2,
										output_tokens: 0,
										cache_read_input_tokens: 0,
										cache_creation_input_tokens: 0,
									},
								},
							},
							{
								type: "content_block_start",
								index: 0,
								content_block: {
									type: "server_tool_use",
									id: "srvu_1",
									name: TOOL_SEARCH_BM25_NAME,
									input: { query: "browser" },
								},
							},
							{
								type: "content_block_delta",
								index: 0,
								delta: { type: "input_json_delta", partial_json: "{}" },
							},
							{ type: "content_block_stop", index: 0 },
							toolSearchResultEvent,
							{ type: "content_block_stop", index: 1 },
							{
								type: "content_block_start",
								index: 2,
								content_block: { type: "tool_use", id: "toolu_1", name: "browser_click", input: {} },
							},
							{
								type: "content_block_delta",
								index: 2,
								delta: { type: "input_json_delta", partial_json: '{"value":"x"}' },
							},
							{ type: "content_block_stop", index: 2 },
							{
								type: "message_delta",
								delta: { stop_reason: "tool_use", stop_sequence: null },
								usage: {
									input_tokens: 2,
									output_tokens: 1,
									cache_read_input_tokens: 0,
									cache_creation_input_tokens: 0,
									server_tool_use: { tool_search_requests: 1 },
								},
							},
							{ type: "message_stop" },
						]),
						{ status: 200, headers: { "content-type": "text/event-stream" } },
					),
			}),
		},
	};
	const stream = streamAnthropic(model, context, { client: fakeClient as never });
	const events: AssistantMessageEvent[] = [];
	for await (const event of stream) events.push(event);
	const result = await stream.result();
	assert(!events.some((event) => event.type === "error"), "server-side search blocks must not crash the parser");
	assert(result.stopReason === "toolUse", "normal tool use stop reason must still be preserved");
	const content = result.content[0];
	if (content?.type !== "toolCall") {
		throw new Error("tool-search-smoke: only the normal downstream tool call should be emitted");
	}
	assert(content.name === "browser_click", "normal tool call name must be preserved");
	assert(content.arguments.value === "x", "normal tool call arguments must be parsed");
	assert(result.content.length === 1, "server_tool_use and tool_search_tool_result must not become assistant content");
}

console.log(JSON.stringify({ ok: true }));
