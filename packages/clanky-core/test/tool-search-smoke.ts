import {
	buildCatalog,
	computeDeferrableNames,
	createToolSearchExtensionFactory,
	resolveToolSearchConfig,
	searchCatalog,
	TOOL_SEARCH_TOOL_NAME,
	type ToolSearchToolInput,
} from "@clanky/core";
import type {
	ExtensionContext,
	ExtensionFactory,
	SourceInfo,
	ToolDefinition,
	ToolInfo,
} from "@earendil-works/pi-coding-agent";

type Pi = Parameters<ExtensionFactory>[0];

function sourceInfo(source: string, name: string): SourceInfo {
	return { path: `<${source}:${name}>`, source, scope: "user", origin: "top-level" };
}

function tool(name: string, description: string, source: "sdk" | "builtin", paramNames: string[] = []): ToolInfo {
	const properties: Record<string, unknown> = {};
	for (const param of paramNames) properties[param] = { type: "string" };
	return {
		name,
		description,
		parameters: { type: "object", properties },
		sourceInfo: sourceInfo(source, name),
	} as unknown as ToolInfo;
}

const FIXTURE_TOOLS: ToolInfo[] = [
	tool("read", "Read a file from disk.", "builtin", ["path"]),
	tool("bash", "Run a shell command.", "builtin", ["command"]),
	tool("edit", "Edit a file.", "builtin", ["path", "old", "new"]),
	tool("memory_search", "Search Clanky's source-grounded memory atoms.", "sdk", ["query"]),
	tool("memory_remember", "Store a durable memory atom.", "sdk", ["claim"]),
	tool("memory_forget", "Forget a memory atom.", "sdk", ["id"]),
	tool("main_session_context", "Read the main Pi session context window.", "sdk", ["limit"]),
	tool("mcp_list_tools", "List tools exposed by external MCP servers.", "sdk", ["server"]),
	tool("mcp_call", "Call a tool on an external MCP server.", "sdk", ["server", "tool"]),
	tool("browser_click", "Click an element on the current web page.", "sdk", ["selector"]),
	tool("browser_screenshot", "Capture a screenshot of the current browser tab.", "sdk", ["tabId"]),
	tool("web_search", "Search the web for current information.", "sdk", ["query"]),
	tool("openai_image_generate", "Generate an image with OpenAI from a text prompt.", "sdk", ["prompt"]),
	tool("discord_send_message", "Send a message to a Discord channel.", "sdk", ["channelId", "content"]),
];

const DEFERRABLE_FIXTURE = [
	"browser_click",
	"browser_screenshot",
	"web_search",
	"openai_image_generate",
	"discord_send_message",
];

function createFakePi(): {
	pi: Pi;
	getActive: () => string[];
	getRegistered: () => ToolDefinition[];
	getHandler: (event: string) => ((event: unknown, ctx: unknown) => unknown) | undefined;
} {
	const registry: ToolInfo[] = [...FIXTURE_TOOLS];
	const registeredDefs: ToolDefinition[] = [];
	let active = new Set(FIXTURE_TOOLS.map((t) => t.name));
	const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
	const pi = {
		getAllTools: () => registry,
		getActiveTools: () => [...active],
		setActiveTools: (names: string[]) => {
			active = new Set(names.filter((name) => registry.some((t) => t.name === name)));
		},
		registerTool: (definition: ToolDefinition) => {
			registeredDefs.push(definition);
			registry.push({
				name: definition.name,
				description: definition.description,
				parameters: definition.parameters,
				sourceInfo: sourceInfo("sdk", definition.name),
			} as unknown as ToolInfo);
			active.add(definition.name);
		},
		on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => {
			handlers.set(event, handler);
		},
	} as unknown as Pi;
	return {
		pi,
		getActive: () => [...active],
		getRegistered: () => registeredDefs,
		getHandler: (event) => handlers.get(event),
	};
}

function assert(condition: boolean, message: string): void {
	if (!condition) throw new Error(`tool-search-smoke: ${message}`);
}

// --- 1. Deferrable classification: only sdk tools, minus always-active and tool_search ---
{
	const config = resolveToolSearchConfig({ env: {} });
	const deferrable = computeDeferrableNames(FIXTURE_TOOLS, config);
	for (const expected of DEFERRABLE_FIXTURE) {
		assert(deferrable.has(expected), `expected ${expected} to be deferrable`);
	}
	for (const builtin of ["read", "bash", "edit"]) {
		assert(!deferrable.has(builtin), `builtin ${builtin} must never be deferred`);
	}
	for (const essential of [
		"memory_search",
		"memory_remember",
		"memory_forget",
		"main_session_context",
		"mcp_list_tools",
		"mcp_call",
	]) {
		assert(!deferrable.has(essential), `essential ${essential} must stay active`);
	}
	assert(deferrable.size === DEFERRABLE_FIXTURE.length, `unexpected deferrable count: ${deferrable.size}`);
}

// --- 2. BM25 ranking returns the most relevant deferred tool first ---
{
	const config = resolveToolSearchConfig({ env: {} });
	const deferrable = computeDeferrableNames(FIXTURE_TOOLS, config);
	const catalog = buildCatalog(FIXTURE_TOOLS, deferrable);
	const clickHits = searchCatalog(catalog, "click element web page", 3);
	assert(clickHits[0]?.name === "browser_click", `expected browser_click first, got ${clickHits[0]?.name}`);
	const imageHits = searchCatalog(catalog, "generate image from prompt", 3);
	assert(
		imageHits[0]?.name === "openai_image_generate",
		`expected openai_image_generate first, got ${imageHits[0]?.name}`,
	);
	// Substring fallback when no token overlaps.
	const fallback = searchCatalog(catalog, "discord", 3);
	assert(
		fallback.some((entry) => entry.name === "discord_send_message"),
		"expected discord substring fallback hit",
	);
}

// --- 3. Factory in "on" mode deactivates deferrable tools at session_start ---
{
	const { pi, getActive, getRegistered, getHandler } = createFakePi();
	const factory = createToolSearchExtensionFactory({ env: {}, overrides: { mode: "on" } });
	factory(pi);
	assert(
		getRegistered().some((def) => def.name === TOOL_SEARCH_TOOL_NAME),
		"tool_search must be registered",
	);

	const sessionStart = getHandler("session_start");
	assert(sessionStart !== undefined, "session_start handler must be registered");
	const ctx = { getContextUsage: () => undefined } as unknown as ExtensionContext;
	await sessionStart?.({ type: "session_start", reason: "startup" }, ctx);

	const activeAfter = new Set(getActive());
	for (const deferred of DEFERRABLE_FIXTURE) {
		assert(!activeAfter.has(deferred), `${deferred} should be deactivated after session_start`);
	}
	assert(activeAfter.has(TOOL_SEARCH_TOOL_NAME), "tool_search must remain active");
	assert(activeAfter.has("memory_search"), "memory_search must remain active");
	assert(activeAfter.has("read"), "builtin read must remain active");

	// --- 4. before_agent_start injects a reminder listing the still-deferred tools ---
	const beforeAgent = getHandler("before_agent_start");
	assert(beforeAgent !== undefined, "before_agent_start handler must be registered");
	const result = (await beforeAgent?.(
		{ type: "before_agent_start", prompt: "hi", systemPrompt: "BASE PROMPT" },
		ctx,
	)) as { systemPrompt?: string } | undefined;
	const prompt = result?.systemPrompt ?? "";
	assert(prompt.startsWith("BASE PROMPT"), "reminder must append to the existing system prompt");
	assert(prompt.includes("<deferred-tools>"), "reminder must include the deferred-tools block");
	assert(prompt.includes("browser_click"), "reminder must list a deferred tool name");
	assert(!prompt.includes("memory_search"), "reminder must not list always-active tools");

	// --- 5. tool_search activates a matched tool so it becomes directly callable ---
	const toolSearch = getRegistered().find((def) => def.name === TOOL_SEARCH_TOOL_NAME);
	assert(toolSearch !== undefined, "tool_search definition must exist");
	const searchResult = await toolSearch?.execute(
		"call-1",
		{ query: "screenshot of the browser tab" } satisfies ToolSearchToolInput,
		undefined,
		undefined,
		ctx,
	);
	const activated = (searchResult as { details: { activated: string[] } }).details.activated ?? [];
	assert(
		activated.includes("browser_screenshot"),
		`tool_search should activate browser_screenshot, got ${activated.join(",")}`,
	);
	assert(getActive().includes("browser_screenshot"), "browser_screenshot must now be active");

	// Re-running before_agent_start should no longer list the activated tool.
	const reminder2 = (await beforeAgent?.({ type: "before_agent_start", prompt: "again", systemPrompt: "" }, ctx)) as
		| { systemPrompt?: string }
		| undefined;
	assert(
		!(reminder2?.systemPrompt ?? "").includes("browser_screenshot"),
		"activated tool must drop out of the reminder",
	);

	// --- 6. select: syntax activates an exact tool by name ---
	const selectResult = await toolSearch?.execute(
		"call-2",
		{ query: "select:openai_image_generate" } satisfies ToolSearchToolInput,
		undefined,
		undefined,
		ctx,
	);
	const selectActivated = (selectResult as { details: { activated: string[]; mode: string } }).details ?? {
		activated: [],
		mode: "",
	};
	assert(selectActivated.mode === "select", "select: query must use select mode");
	assert(selectActivated.activated.includes("openai_image_generate"), "select must activate the named tool");
	assert(getActive().includes("openai_image_generate"), "openai_image_generate must now be active");
}

// --- 7. "off" mode registers nothing and defers nothing ---
{
	const { pi, getRegistered, getHandler } = createFakePi();
	const factory = createToolSearchExtensionFactory({ env: {}, overrides: { mode: "off" } });
	factory(pi);
	assert(getRegistered().length === 0, "off mode must not register tool_search");
	assert(getHandler("session_start") === undefined, "off mode must not register handlers");
}

// --- 8. "auto" mode below the token threshold leaves everything active ---
{
	const { pi, getActive, getHandler } = createFakePi();
	const factory = createToolSearchExtensionFactory({
		env: {},
		// Huge fallback threshold -> the tiny fixture never crosses it -> no deferral.
		overrides: { mode: "auto", fallbackThresholdTokens: 10_000_000 },
	});
	factory(pi);
	const sessionStart = getHandler("session_start");
	const ctx = { getContextUsage: () => undefined } as unknown as ExtensionContext;
	await sessionStart?.({ type: "session_start", reason: "startup" }, ctx);
	for (const deferred of DEFERRABLE_FIXTURE) {
		assert(getActive().includes(deferred), `auto mode below threshold must keep ${deferred} active`);
	}
}

// --- 9. Fallback: deferral applies on before_agent_start even if session_start never fires ---
{
	const { pi, getActive, getHandler } = createFakePi();
	const factory = createToolSearchExtensionFactory({ env: {}, overrides: { mode: "on" } });
	factory(pi);
	const ctx = { getContextUsage: () => undefined } as unknown as ExtensionContext;
	const beforeAgent = getHandler("before_agent_start");
	assert(beforeAgent !== undefined, "before_agent_start handler must be registered");
	// No session_start call: simulate a runtime where it has not fired by the first turn.
	await beforeAgent?.({ type: "before_agent_start", prompt: "first turn", systemPrompt: "BASE" }, ctx);
	for (const deferred of DEFERRABLE_FIXTURE) {
		assert(!getActive().includes(deferred), `${deferred} should be deferred by the before_agent_start fallback`);
	}
	// One-time guard: a tool activated mid-session must not be re-deferred on the next turn.
	pi.setActiveTools([...getActive(), "browser_click"]);
	await beforeAgent?.({ type: "before_agent_start", prompt: "second turn", systemPrompt: "BASE" }, ctx);
	assert(getActive().includes("browser_click"), "mid-session activation must survive subsequent turns");
}

console.log(JSON.stringify({ ok: true, deferrable: DEFERRABLE_FIXTURE.length }));
