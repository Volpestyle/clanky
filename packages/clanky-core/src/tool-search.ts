// Tool search: progressive tool disclosure for Clanky.
//
// Clanky registers ~50 model-facing tools (browser operator, media generation,
// Discord, subagents, memory, MCP bridges, ...). Sending every schema to the
// model on every turn burns a large, fixed slice of the context window before
// any work starts. This module defers the bulk of those tools: at session start
// it deactivates the deferrable tools so their schemas leave the provider
// payload, registers a single `tool_search` tool, and injects a per-turn system
// reminder listing the deferred tool names. When the model searches, the
// matching tools are re-activated via Pi's setActiveTools, so their full schemas
// appear on the next step and the model calls them directly. No bridge
// re-dispatch is needed because Pi dispatches the activated tools natively.
//
// Ported in spirit from hermes-agent's tool_search (BM25 + substring fallback,
// stateless catalog rebuilt from the live registry, core tools never deferred),
// adapted to Pi's setActiveTools seam instead of tool_call bridges.

import {
	type AgentToolResult,
	defineTool,
	type ExtensionAPI,
	type ExtensionContext,
	type ExtensionFactory,
	type ToolDefinition,
	type ToolInfo,
} from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";

export const TOOL_SEARCH_TOOL_NAME = "tool_search";

/** Direct-activation prefix: `tool_search` with `select:a,b,c` activates those exact tools. */
const SELECT_PREFIX = "select:";

/** Rough chars-per-token estimate for gating. Intentionally conservative (underestimates). */
const CHARS_PER_TOKEN = 4;

/** Description cap in search results to keep chatty tools from bloating the payload. */
const DESCRIPTION_CAP = 400;

/**
 * Clanky-native tools that stay active regardless of deferral. These are the
 * tools used so often that searching for them would only add latency: memory,
 * the main-session context window, and the MCP bridges (which are themselves a
 * deferral mechanism for external MCP servers).
 */
export const DEFAULT_ALWAYS_ACTIVE_TOOLS: readonly string[] = [
	"memory_remember",
	"memory_search",
	"memory_forget",
	"main_session_context",
	"mcp_list_tools",
	"mcp_call",
];

export type ToolSearchMode = "auto" | "on" | "off";

export interface ToolSearchConfig {
	/** "off": never defer. "on": always defer the deferrable set. "auto": defer only past the token threshold. */
	mode: ToolSearchMode;
	/** In "auto" mode, defer when deferrable schemas exceed this percent of the context window. */
	thresholdPct: number;
	/** In "auto" mode, threshold used when the context window size is unknown. */
	fallbackThresholdTokens: number;
	/** Default number of matches returned by tool_search. */
	searchDefaultLimit: number;
	/** Upper bound on the matches tool_search will return. */
	maxSearchLimit: number;
	/** Tool names (in addition to Pi built-ins and tool_search) that are never deferred. */
	alwaysActive: readonly string[];
}

export interface ToolSearchConfigOverrides {
	mode?: ToolSearchMode;
	thresholdPct?: number;
	fallbackThresholdTokens?: number;
	searchDefaultLimit?: number;
	maxSearchLimit?: number;
	/** Extra always-active tool names, merged with DEFAULT_ALWAYS_ACTIVE_TOOLS. */
	alsoAlwaysActive?: readonly string[];
}

export interface ToolSearchFactoryOptions {
	env?: NodeJS.ProcessEnv;
	overrides?: ToolSearchConfigOverrides;
}

const DEFAULT_CONFIG: ToolSearchConfig = {
	mode: "auto",
	thresholdPct: 8,
	fallbackThresholdTokens: 12_000,
	searchDefaultLimit: 5,
	maxSearchLimit: 20,
	alwaysActive: DEFAULT_ALWAYS_ACTIVE_TOOLS,
};

function parseMode(value: string | undefined): ToolSearchMode | undefined {
	if (value === undefined) return undefined;
	const normalized = value.trim().toLowerCase();
	if (normalized === "off" || normalized === "on" || normalized === "auto") return normalized;
	if (normalized === "false" || normalized === "0" || normalized === "no") return "off";
	if (normalized === "true" || normalized === "1" || normalized === "yes") return "on";
	return undefined;
}

function parsePositiveNumber(value: string | undefined): number | undefined {
	if (value === undefined) return undefined;
	const parsed = Number(value.trim());
	if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
	return parsed;
}

function parseNameList(value: string | undefined): string[] {
	if (value === undefined) return [];
	return value
		.split(",")
		.map((entry) => entry.trim())
		.filter((entry) => entry.length > 0);
}

function clamp(value: number, min: number, max: number): number {
	return Math.max(min, Math.min(max, value));
}

/**
 * Resolve config from defaults, env overrides, then explicit overrides (explicit wins).
 * Env keys: CLANKY_TOOL_SEARCH, CLANKY_TOOL_SEARCH_THRESHOLD_PCT, CLANKY_TOOL_SEARCH_LIMIT,
 * CLANKY_TOOL_SEARCH_MAX_LIMIT, CLANKY_TOOL_SEARCH_ALWAYS_ACTIVE.
 */
export function resolveToolSearchConfig(options: ToolSearchFactoryOptions = {}): ToolSearchConfig {
	const env = options.env ?? process.env;
	const overrides = options.overrides ?? {};
	const mode = overrides.mode ?? parseMode(env.CLANKY_TOOL_SEARCH) ?? DEFAULT_CONFIG.mode;
	const thresholdPct = clamp(
		overrides.thresholdPct ?? parsePositiveNumber(env.CLANKY_TOOL_SEARCH_THRESHOLD_PCT) ?? DEFAULT_CONFIG.thresholdPct,
		0.5,
		100,
	);
	const fallbackThresholdTokens = overrides.fallbackThresholdTokens ?? DEFAULT_CONFIG.fallbackThresholdTokens;
	const maxSearchLimit = Math.floor(
		clamp(
			overrides.maxSearchLimit ??
				parsePositiveNumber(env.CLANKY_TOOL_SEARCH_MAX_LIMIT) ??
				DEFAULT_CONFIG.maxSearchLimit,
			1,
			50,
		),
	);
	const searchDefaultLimit = Math.floor(
		clamp(
			overrides.searchDefaultLimit ??
				parsePositiveNumber(env.CLANKY_TOOL_SEARCH_LIMIT) ??
				DEFAULT_CONFIG.searchDefaultLimit,
			1,
			maxSearchLimit,
		),
	);
	const alwaysActive = [
		...DEFAULT_ALWAYS_ACTIVE_TOOLS,
		...parseNameList(env.CLANKY_TOOL_SEARCH_ALWAYS_ACTIVE),
		...(overrides.alsoAlwaysActive ?? []),
	];
	return { mode, thresholdPct, fallbackThresholdTokens, searchDefaultLimit, maxSearchLimit, alwaysActive };
}

// --- Catalog + BM25 (ported from hermes-agent tools/tool_search.py) ---

export interface CatalogEntry {
	name: string;
	description: string;
	source: string;
	tokens: string[];
	/** Estimated token cost of this tool's schema, used for threshold gating. */
	schemaTokens: number;
}

const TOKEN_RE = /[a-z0-9]+/g;

function tokenize(text: string): string[] {
	const matches = text.toLowerCase().match(TOKEN_RE);
	return matches === null ? [] : matches;
}

function schemaPropertyNames(parameters: ToolInfo["parameters"]): string[] {
	const props = (parameters as { properties?: Record<string, unknown> }).properties;
	if (props === undefined || props === null || typeof props !== "object") return [];
	return Object.keys(props);
}

function entrySearchText(tool: ToolInfo): string {
	const nameWords = tool.name.replace(/[_.\-:]+/g, " ");
	const paramNames = schemaPropertyNames(tool.parameters).join(" ");
	return `${nameWords} ${tool.description ?? ""} ${paramNames}`;
}

function estimateSchemaTokens(tool: ToolInfo): number {
	const serialized = JSON.stringify({
		name: tool.name,
		description: tool.description,
		parameters: tool.parameters,
	});
	return Math.ceil(serialized.length / CHARS_PER_TOKEN);
}

function bm25Score(
	queryTokens: readonly string[],
	docTokens: readonly string[],
	avgDocLength: number,
	docFreq: Map<string, number>,
	docCount: number,
): number {
	const k1 = 1.5;
	const b = 0.75;
	const docLength = docTokens.length;
	const termFreq = new Map<string, number>();
	for (const token of docTokens) termFreq.set(token, (termFreq.get(token) ?? 0) + 1);
	let score = 0;
	for (const query of queryTokens) {
		const df = docFreq.get(query) ?? 0;
		if (df === 0) continue;
		const tf = termFreq.get(query) ?? 0;
		if (tf === 0) continue;
		const idf = Math.log(1 + (docCount - df + 0.5) / (df + 0.5));
		const norm = (tf * (k1 + 1)) / (tf + k1 * (1 - b + (b * docLength) / Math.max(avgDocLength, 1)));
		score += idf * norm;
	}
	return score;
}

/** Build the deferrable-tool catalog from the live registry. Stateless: rebuilt on each call. */
export function buildCatalog(allTools: readonly ToolInfo[], deferrableNames: ReadonlySet<string>): CatalogEntry[] {
	const catalog: CatalogEntry[] = [];
	for (const tool of allTools) {
		if (!deferrableNames.has(tool.name)) continue;
		catalog.push({
			name: tool.name,
			description: tool.description ?? "",
			source: tool.sourceInfo.source,
			tokens: tokenize(entrySearchText(tool)),
			schemaTokens: estimateSchemaTokens(tool),
		});
	}
	return catalog;
}

/** BM25 ranking with a name-substring fallback when every doc shares the query term (zero IDF). */
export function searchCatalog(catalog: readonly CatalogEntry[], query: string, limit: number): CatalogEntry[] {
	const queryTokens = tokenize(query);
	if (queryTokens.length === 0) return [];
	const docCount = catalog.length;
	const docFreq = new Map<string, number>();
	let totalLength = 0;
	for (const entry of catalog) {
		totalLength += entry.tokens.length;
		for (const token of new Set(entry.tokens)) docFreq.set(token, (docFreq.get(token) ?? 0) + 1);
	}
	const avgDocLength = docCount === 0 ? 0 : totalLength / docCount;
	const scored: Array<{ score: number; entry: CatalogEntry }> = [];
	for (const entry of catalog) {
		const score = bm25Score(queryTokens, entry.tokens, avgDocLength, docFreq, docCount);
		if (score > 0) scored.push({ score, entry });
	}
	if (scored.length === 0) {
		const needle = query.trim().toLowerCase();
		for (const entry of catalog) {
			if (needle.length > 0 && entry.name.toLowerCase().includes(needle)) scored.push({ score: 0.1, entry });
		}
	}
	scored.sort((a, b) => b.score - a.score);
	return scored.slice(0, Math.max(1, limit)).map((hit) => hit.entry);
}

// --- Deferral classification ---

/**
 * A tool is deferrable when it is one of Clanky's own model-facing tools
 * (sourceInfo.source === "sdk"), is not tool_search itself, and is not in the
 * always-active allowlist. Pi built-ins (read/bash/edit/write/grep/find/ls) and
 * any non-sdk source are never deferred.
 */
export function computeDeferrableNames(allTools: readonly ToolInfo[], config: ToolSearchConfig): Set<string> {
	const alwaysActive = new Set(config.alwaysActive);
	const deferrable = new Set<string>();
	for (const tool of allTools) {
		if (tool.name === TOOL_SEARCH_TOOL_NAME) continue;
		if (tool.sourceInfo.source !== "sdk") continue;
		if (alwaysActive.has(tool.name)) continue;
		deferrable.add(tool.name);
	}
	return deferrable;
}

function resolveThresholdTokens(config: ToolSearchConfig, ctx: ExtensionContext): number {
	const contextWindow = ctx.getContextUsage()?.contextWindow;
	if (contextWindow !== undefined && contextWindow > 0) {
		return Math.ceil((contextWindow * config.thresholdPct) / 100);
	}
	return config.fallbackThresholdTokens;
}

// --- The tool_search tool ---

const toolSearchSchema = Type.Object({
	query: Type.String({
		description:
			'Keywords describing the capability you need (e.g. "click button on web page", "generate an image"). Or "select:exact_tool_name,other_name" to activate specific tools by exact name.',
	}),
	limit: Type.Optional(
		Type.Integer({
			description: "Maximum number of matches to return and activate. Defaults to the configured limit.",
		}),
	),
});

export type ToolSearchToolInput = Static<typeof toolSearchSchema>;

function activateTools(pi: ExtensionAPI, names: readonly string[]): void {
	if (names.length === 0) return;
	const next = new Set(pi.getActiveTools());
	for (const name of names) next.add(name);
	pi.setActiveTools([...next]);
}

function createToolSearchTool(pi: ExtensionAPI, config: ToolSearchConfig): ToolDefinition {
	return defineTool({
		name: TOOL_SEARCH_TOOL_NAME,
		label: "Tool Search",
		description:
			"Search Clanky's deferred tools (loaded on demand to save context) and activate the matches. Returns matching tool names with short descriptions; the activated tools' full parameter schemas become available so you can call them directly on your next step. Pass a capability query, or 'select:exact_name,...' to activate tools by exact name.",
		promptSnippet:
			"tool_search: find and activate deferred tools (browser, media generation, Discord, subagents, scheduling, ...) by capability query before calling them.",
		promptGuidelines: [
			"When you need a capability whose tool is not in the active list, call tool_search first; activated tools become directly callable on the next step.",
			"Use 'select:exact_name' in the query to re-activate a specific tool you already know by name.",
		],
		parameters: toolSearchSchema,
		async execute(_toolCallId, params: ToolSearchToolInput): Promise<AgentToolResult<unknown>> {
			const deferrableNames = computeDeferrableNames(pi.getAllTools(), config);
			const rawQuery = (params.query ?? "").trim();
			const limit = clamp(params.limit ?? config.searchDefaultLimit, 1, config.maxSearchLimit);

			let matchedNames: string[];
			let mode: "select" | "search";
			if (rawQuery.toLowerCase().startsWith(SELECT_PREFIX)) {
				mode = "select";
				const requested = parseNameList(rawQuery.slice(SELECT_PREFIX.length));
				matchedNames = requested.filter((name) => deferrableNames.has(name));
			} else {
				mode = "search";
				const catalog = buildCatalog(pi.getAllTools(), deferrableNames);
				matchedNames = searchCatalog(catalog, rawQuery, limit).map((entry) => entry.name);
			}

			activateTools(pi, matchedNames);

			const allTools = pi.getAllTools();
			const descriptionByName = new Map(allTools.map((tool) => [tool.name, tool.description ?? ""]));
			const matches = matchedNames.map((name) => ({
				name,
				description: descriptionByName.get(name)?.slice(0, DESCRIPTION_CAP) ?? "",
			}));
			const unknownSelected =
				mode === "select"
					? parseNameList(rawQuery.slice(SELECT_PREFIX.length)).filter((name) => !deferrableNames.has(name))
					: [];

			const details = {
				query: rawQuery,
				mode,
				total_deferred: deferrableNames.size,
				activated: matchedNames,
				matches,
				...(unknownSelected.length > 0 ? { not_deferrable: unknownSelected } : {}),
				note:
					matchedNames.length > 0
						? "Activated. These tools are now directly callable on your next step; do not call tool_search again for them."
						: "No deferred tools matched. Try different keywords or 'select:exact_name'.",
			};
			return {
				content: [{ type: "text", text: JSON.stringify(details, null, "\t") }],
				details,
			};
		},
	});
}

// --- System reminder for deferred tools ---

function formatDeferredReminder(deferredNames: readonly string[]): string {
	const sorted = [...deferredNames].sort();
	return [
		"<deferred-tools>",
		`${sorted.length} tools are deferred to save context: only their names are listed below, not their parameter schemas.`,
		`To use one, call ${TOOL_SEARCH_TOOL_NAME} with a capability query (or "select:exact_name"). Matching tools are activated and become directly callable on your next step.`,
		"",
		sorted.join(", "),
		"</deferred-tools>",
	].join("\n");
}

function appendReminder(systemPrompt: string, reminder: string): string {
	return systemPrompt.length > 0 ? `${systemPrompt}\n\n${reminder}` : reminder;
}

/** Names of deferrable tools that are not currently active (i.e. still hidden from the model). */
function currentlyDeferredNames(pi: ExtensionAPI, config: ToolSearchConfig): string[] {
	const deferrable = computeDeferrableNames(pi.getAllTools(), config);
	const active = new Set(pi.getActiveTools());
	return [...deferrable].filter((name) => !active.has(name));
}

/**
 * Deactivate the deferrable tools when deferral should apply. In "auto" mode this
 * only happens once the deferrable schemas exceed the configured token threshold.
 * Returns the names that were deferred (empty when deferral did not apply).
 */
function applyInitialDeferral(pi: ExtensionAPI, config: ToolSearchConfig, ctx: ExtensionContext): string[] {
	const allTools = pi.getAllTools();
	const deferrable = computeDeferrableNames(allTools, config);
	if (deferrable.size === 0) return [];

	if (config.mode === "auto") {
		const deferrableTokens = allTools
			.filter((tool) => deferrable.has(tool.name))
			.reduce((sum, tool) => sum + estimateSchemaTokens(tool), 0);
		if (deferrableTokens < resolveThresholdTokens(config, ctx)) return [];
	}

	const keep = pi.getActiveTools().filter((name) => !deferrable.has(name));
	pi.setActiveTools(keep);
	return [...deferrable];
}

/**
 * Extension factory implementing tool search. Registers the tool_search tool,
 * deactivates the deferrable tools, and injects a per-turn system reminder
 * listing the still-deferred tool names.
 *
 * Deferral is applied at session_start (so the first assembled system prompt
 * already excludes deferred tools) and, as a fallback for runtimes where
 * session_start has not fired by the first turn, lazily at before_agent_start.
 * A one-time guard keeps the model's mid-session activations from being undone;
 * session_start resets it so a fresh/resumed session re-defers from scratch.
 */
export function createToolSearchExtensionFactory(options: ToolSearchFactoryOptions = {}): ExtensionFactory {
	const config = resolveToolSearchConfig(options);
	return (pi) => {
		if (config.mode === "off") return;
		pi.registerTool(createToolSearchTool(pi, config));
		let deferralApplied = false;
		const ensureDeferral = (ctx: ExtensionContext): void => {
			if (deferralApplied) return;
			deferralApplied = true;
			applyInitialDeferral(pi, config, ctx);
		};
		pi.on("session_start", async (_event, ctx) => {
			deferralApplied = false;
			ensureDeferral(ctx);
		});
		pi.on("before_agent_start", async (event, ctx) => {
			ensureDeferral(ctx);
			const deferred = currentlyDeferredNames(pi, config);
			if (deferred.length === 0) return undefined;
			return { systemPrompt: appendReminder(event.systemPrompt, formatDeferredReminder(deferred)) };
		});
	};
}
