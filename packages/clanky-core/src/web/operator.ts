import { constants, existsSync } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AuthStorage } from "@earendil-works/pi-coding-agent";
import { getOpenAiCredentialStatus, resolveOpenAiApiKey } from "../openai-credentials.ts";
import { resolveClankyPaths } from "../paths.ts";
import { isRecord } from "../util/values.ts";

export type SearchContextSize = "low" | "medium" | "high";
export type ReturnTokenBudget = "default" | "unlimited";
export type ReasoningEffort = "low" | "medium" | "high" | "xhigh";

export interface OpenAiWebSearchInput {
	query: string;
	instructions?: string;
	model?: string;
	searchContextSize?: SearchContextSize;
	search_context_size?: SearchContextSize;
	allowedDomains?: string[];
	allowed_domains?: string[];
	blockedDomains?: string[];
	blocked_domains?: string[];
	externalWebAccess?: boolean;
	external_web_access?: boolean;
	returnTokenBudget?: ReturnTokenBudget;
	return_token_budget?: ReturnTokenBudget;
	reasoningEffort?: ReasoningEffort;
	reasoning_effort?: ReasoningEffort;
	userLocation?: ApproximateUserLocation;
	user_location?: ApproximateUserLocation;
}

export interface ApproximateUserLocation {
	city?: string;
	region?: string;
	country?: string;
	timezone?: string;
}

export interface OpenAiWebSearchOptions {
	authStorage?: AuthStorage;
	env?: NodeJS.ProcessEnv;
	fetchImpl?: typeof fetch;
	signal?: AbortSignal;
}

export interface OpenAiWebCitation {
	url: string;
	title?: string;
	startIndex?: number;
	endIndex?: number;
}

export interface OpenAiWebSearchResult {
	provider: "openai";
	model: string;
	responseId?: string;
	status?: string;
	answer: string;
	citations: OpenAiWebCitation[];
	sources: unknown[];
	actions: unknown[];
	usage?: unknown;
}

export interface WebBackendStatusOptions {
	authStorage?: AuthStorage;
	cwd?: string;
	env?: NodeJS.ProcessEnv;
	fetchImpl?: typeof fetch;
}

interface PackageJson {
	scripts?: Record<string, string>;
	dependencies?: Record<string, string>;
	devDependencies?: Record<string, string>;
}

const DEFAULT_WEB_SEARCH_MODEL = "gpt-5.5";

export async function runOpenAiWebSearch(
	input: OpenAiWebSearchInput,
	options: OpenAiWebSearchOptions = {},
): Promise<OpenAiWebSearchResult> {
	const env = options.env ?? process.env;
	const fetchImpl = options.fetchImpl ?? fetch;
	const apiKey = await resolveOpenAiApiKey(env, options.authStorage);
	if (apiKey === undefined) {
		throw new Error(
			"OpenAI credentials are required for web_search. Run /openai-login or set OPENAI_API_KEY/CLANKY_OPENAI_API_KEY.",
		);
	}

	const query = input.query.trim();
	if (query.length === 0) throw new Error("web_search query must not be empty.");

	const model = input.model?.trim() || env.CLANKY_WEB_SEARCH_MODEL || DEFAULT_WEB_SEARCH_MODEL;
	const requestBody = buildOpenAiWebSearchRequest(input, query, model);
	const requestInit: RequestInit = {
		method: "POST",
		headers: {
			authorization: `Bearer ${apiKey.value}`,
			"content-type": "application/json",
		},
		body: JSON.stringify(requestBody),
	};
	if (options.signal !== undefined) requestInit.signal = options.signal;
	const response = await fetchImpl("https://api.openai.com/v1/responses", requestInit);

	const rawText = await response.text();
	let payload: unknown;
	try {
		payload = rawText.length > 0 ? JSON.parse(rawText) : {};
	} catch {
		payload = { raw: rawText };
	}

	if (!response.ok) {
		throw new Error(`OpenAI web_search failed (${response.status}): ${summarizeOpenAiError(payload)}`);
	}

	return parseOpenAiWebSearchResponse(payload, model);
}

export async function getWebBackendStatus(options: WebBackendStatusOptions = {}): Promise<unknown> {
	const env = options.env ?? process.env;
	const cwd = options.cwd ?? process.cwd();
	const clankyRoot = resolveClankyRoot();
	const packageJson = await readPackageJson(join(clankyRoot, "package.json"));
	const pnpm = await resolveExecutable("pnpm", env);
	const node = await resolveExecutable("node", env);
	const agentBrowser = await resolveExecutable("agent-browser", env);
	const openAiStatus = getOpenAiCredentialStatus(env, options.authStorage);
	const bridge = await readBrowserBridgeState(env, options.fetchImpl ?? fetch);

	const agentBrowserAvailable = agentBrowser !== undefined;
	const agentBrowserBackend: Record<string, unknown> = {
		available: agentBrowserAvailable,
		command: "agent-browser",
		bestFor: ["persistent browser sessions", "headed browsing", "authenticated browser profiles"],
	};
	if (agentBrowser !== undefined) {
		agentBrowserBackend.path = agentBrowser;
	} else {
		agentBrowserBackend.note = "agent-browser is optional and not installed. Skip it and use a different backend.";
	}

	return {
		cwd,
		clankyRoot,
		openaiWebSearch: {
			available: openAiStatus.available,
			model: env.CLANKY_WEB_SEARCH_MODEL || DEFAULT_WEB_SEARCH_MODEL,
			apiKeySource: openAiStatus.activeSource,
			acceptedApiKeySources: ["CLANKY_OPENAI_API_KEY", "OPENAI_API_KEY", "stored openai AuthStorage credential"],
			access: openAiStatus.available ? "not_checked_until_tool_call" : "missing_credentials",
		},
		backends: {
			browserBridge: bridge,
			agentBrowser: agentBrowserBackend,
			playwrightCli: {
				available: pnpm !== undefined && hasScript(packageJson, "browser:playwright"),
				command: "pnpm browser:playwright",
				installCommand: hasScript(packageJson, "browser:install") ? "pnpm browser:install" : undefined,
				bestFor: ["fresh browser contexts", "JavaScript-rendered pages", "screenshots", "repeatable automation"],
				note: 'Never use waitUntil: "networkidle" on modern sites (Discord, X, GitHub, Linear). Use "domcontentloaded" and wait for a specific selector instead.',
			},
			chromeCdp: {
				available: pnpm !== undefined && hasScript(packageJson, "browser:cdp"),
				command: "pnpm browser:cdp",
				launchCommand: hasScript(packageJson, "browser:chrome-debug") ? "pnpm browser:chrome-debug" : undefined,
				bestFor: ["attaching to an existing Chrome DevTools Protocol session"],
			},
			nodeFetch: {
				available: node !== undefined,
				command: "node",
				bestFor: ["known public URLs", "plain HTTP/HTML/JSON fetches"],
			},
		},
		tools: {
			pnpm: { available: pnpm !== undefined, path: pnpm },
			node: { available: node !== undefined, path: node },
		},
	};
}

interface BrowserBridgeStateRecord {
	port?: number;
	pid?: number;
	browser?: string;
	startedAt?: string;
}

interface BrowserBridgeExtensionInfo {
	browser: string;
	version: string;
	stale: boolean;
}

interface BrowserBridgeHealthResult {
	reachable: boolean;
	connectionCount?: number;
	connectedBrowsers?: string[];
	expectedExtensionVersion?: string;
	extensions?: BrowserBridgeExtensionInfo[];
	error?: string;
}

async function readBrowserBridgeState(
	env: NodeJS.ProcessEnv,
	fetchImpl: typeof fetch,
): Promise<Record<string, unknown>> {
	const stateFile = browserBridgeStateFile(env);
	const preferred = resolveBrowserBridgePreferred(env);
	const bestFor = [
		"opening any URL the user should see in their own browser",
		"capturing screenshots and driving tabs via browser tools",
		"loading pages with the user's logged-in profile and extensions",
		"handing the user a live tab they can interact with directly",
	];
	try {
		const raw = await readFile(stateFile, "utf8");
		let parsed: unknown;
		try {
			parsed = JSON.parse(raw) as unknown;
		} catch {
			return { available: false, preferred, stateFile, bestFor, note: "browser-bridge state file is malformed." };
		}
		if (!isRecord(parsed)) {
			return { available: false, preferred, stateFile, bestFor, note: "browser-bridge state file is malformed." };
		}
		const state = parsed as BrowserBridgeStateRecord;
		if (typeof state.port !== "number" || typeof state.pid !== "number") {
			return {
				available: false,
				preferred,
				stateFile,
				bestFor,
				note: "browser-bridge state file is missing port/pid. Restart the daemon with pnpm browser-bridge:serve.",
			};
		}
		const browser = state.browser ?? "unknown";
		const health = await readBrowserBridgeHealth(state.port, fetchImpl);
		if (!health.reachable) {
			return {
				available: false,
				preferred,
				stateFile,
				port: state.port,
				browser,
				startedAt: state.startedAt,
				bestFor,
				note: `browser-bridge state file exists, but the daemon is not reachable on 127.0.0.1:${state.port}${
					health.error === undefined ? "" : ` (${health.error})`
				}. Restart it with pnpm browser-bridge:serve.`,
			};
		}
		const browserConnected = browser !== "disconnected" && browser !== "unknown";
		if (!browserConnected || (health.connectionCount ?? 0) <= 0) {
			return {
				available: false,
				preferred,
				stateFile,
				port: state.port,
				browser,
				startedAt: state.startedAt,
				connectionCount: health.connectionCount ?? 0,
				connectedBrowsers: health.connectedBrowsers ?? [],
				bestFor,
				note: "browser-bridge daemon is running but no browser extension is connected yet. Load the unpacked extension in Helium/Chrome/Brave.",
			};
		}
		const staleExtensions = (health.extensions ?? []).filter((entry) => entry.stale);
		const staleNote =
			staleExtensions.length > 0
				? `A connected extension is stale (version ${staleExtensions
						.map((entry) => entry.version)
						.join(
							", ",
						)} < packaged ${health.expectedExtensionVersion ?? "unknown"}). Some browser_* ops may fail with "unknown op" until you reload the unpacked extension at chrome://extensions.`
				: undefined;
		return {
			available: true,
			preferred,
			stateFile,
			port: state.port,
			browser,
			startedAt: state.startedAt,
			connectionCount: health.connectionCount ?? 0,
			connectedBrowsers: health.connectedBrowsers ?? [],
			...(health.expectedExtensionVersion === undefined
				? {}
				: { expectedExtensionVersion: health.expectedExtensionVersion }),
			...(health.extensions === undefined ? {} : { extensions: health.extensions }),
			...(staleNote === undefined ? {} : { staleExtension: true, note: staleNote }),
			tool: "browser_open_tab",
			tools: [
				"browser_open_tab",
				"browser_navigate",
				"browser_list_tabs",
				"browser_close_tab",
				"browser_back",
				"browser_forward",
				"browser_reload",
				"browser_read_text",
				"browser_query",
				"browser_eval",
				"browser_fill",
				"browser_wait_for",
				"browser_screenshot",
				"browser_click",
				"browser_double_click",
				"browser_type",
				"browser_key",
				"browser_scroll",
				"browser_hover",
				"browser_wait",
			],
			bestFor,
		};
	} catch {
		return {
			available: false,
			preferred,
			stateFile,
			bestFor,
			note: 'browser-bridge daemon is not running. Run "pnpm browser-bridge:install" once, then "pnpm browser-bridge:serve" and load the unpacked extension in Helium/Chrome/Brave.',
		};
	}
}

async function readBrowserBridgeHealth(port: number, fetchImpl: typeof fetch): Promise<BrowserBridgeHealthResult> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), 750);
	try {
		const response = await fetchImpl(`http://127.0.0.1:${port}/healthz`, { signal: controller.signal });
		if (!response.ok) {
			return { reachable: false, error: `health endpoint returned HTTP ${response.status}` };
		}
		const payload = (await response.json().catch(() => undefined)) as unknown;
		if (!isRecord(payload) || payload.ok !== true) {
			return { reachable: false, error: "health endpoint returned malformed status" };
		}
		const connectedBrowsers = Array.isArray(payload.connectedBrowsers)
			? payload.connectedBrowsers.filter((entry): entry is string => typeof entry === "string")
			: [];
		const connectionCount =
			typeof payload.connectionCount === "number" && Number.isFinite(payload.connectionCount)
				? payload.connectionCount
				: connectedBrowsers.length;
		const extensions: BrowserBridgeExtensionInfo[] = Array.isArray(payload.extensions)
			? payload.extensions.flatMap((entry): BrowserBridgeExtensionInfo[] => {
					if (!isRecord(entry) || typeof entry.browser !== "string" || typeof entry.version !== "string") return [];
					return [{ browser: entry.browser, version: entry.version, stale: entry.stale === true }];
				})
			: [];
		const result: BrowserBridgeHealthResult = { reachable: true, connectionCount, connectedBrowsers, extensions };
		if (typeof payload.expectedExtensionVersion === "string") {
			result.expectedExtensionVersion = payload.expectedExtensionVersion;
		}
		return result;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { reachable: false, error: message.length === 0 ? "fetch failed" : message };
	} finally {
		clearTimeout(timeout);
	}
}

function resolveBrowserBridgePreferred(env: NodeJS.ProcessEnv): boolean {
	const raw = env.CLANKY_PREFER_BROWSER_BRIDGE?.trim().toLowerCase();
	if (raw === undefined || raw.length === 0) return true;
	return raw !== "0" && raw !== "false" && raw !== "no" && raw !== "off";
}

function browserBridgeStateFile(env: NodeJS.ProcessEnv): string {
	const home = resolveClankyPaths({
		...(env.CLANKY_HOME === undefined ? {} : { homeDir: env.CLANKY_HOME }),
	}).homeDir;
	return join(home, "browser-bridge", "state.json");
}

function buildOpenAiWebSearchRequest(
	input: OpenAiWebSearchInput,
	query: string,
	model: string,
): Record<string, unknown> {
	const searchContextSize = input.searchContextSize ?? input.search_context_size ?? "medium";
	const tool: Record<string, unknown> = {
		type: "web_search",
		search_context_size: searchContextSize,
	};

	const allowedDomains = normalizeDomainList(input.allowedDomains ?? input.allowed_domains);
	const blockedDomains = normalizeDomainList(input.blockedDomains ?? input.blocked_domains);
	if (allowedDomains.length > 0) {
		tool.filters = { allowed_domains: allowedDomains };
	} else if (blockedDomains.length > 0) {
		tool.filters = { blocked_domains: blockedDomains };
	}

	const externalWebAccess = input.externalWebAccess ?? input.external_web_access;
	if (externalWebAccess !== undefined) tool.external_web_access = externalWebAccess;

	const returnTokenBudget = input.returnTokenBudget ?? input.return_token_budget;
	if (returnTokenBudget !== undefined) tool.return_token_budget = returnTokenBudget;

	const userLocation = input.userLocation ?? input.user_location;
	if (userLocation !== undefined) {
		tool.user_location = {
			type: "approximate",
			...dropUndefined({
				city: userLocation.city,
				region: userLocation.region,
				country: userLocation.country,
				timezone: userLocation.timezone,
			}),
		};
	}

	const instructions =
		input.instructions?.trim() ||
		"Use hosted web search for current public information. Answer concisely, preserve inline citations, and include enough source detail for the caller to verify the result.";
	const body: Record<string, unknown> = {
		model,
		instructions,
		input: query,
		tools: [tool],
		tool_choice: "required",
		store: false,
	};
	const reasoningEffort = input.reasoningEffort ?? input.reasoning_effort;
	if (reasoningEffort !== undefined) body.reasoning = { effort: reasoningEffort };
	return body;
}

function parseOpenAiWebSearchResponse(payload: unknown, fallbackModel: string): OpenAiWebSearchResult {
	const record = isRecord(payload) ? payload : {};
	const output = Array.isArray(record.output) ? record.output : [];
	const textParts: string[] = [];
	const citations: OpenAiWebCitation[] = [];
	const actions: unknown[] = [];

	for (const item of output) {
		if (!isRecord(item)) continue;
		if (item.type === "web_search_call") {
			actions.push({ id: item.id, status: item.status, action: item.action });
			continue;
		}
		if (item.type !== "message" || !Array.isArray(item.content)) continue;
		for (const content of item.content) {
			if (!isRecord(content)) continue;
			if (typeof content.text === "string") textParts.push(content.text);
			if (!Array.isArray(content.annotations)) continue;
			for (const annotation of content.annotations) {
				if (!isRecord(annotation) || annotation.type !== "url_citation" || typeof annotation.url !== "string") continue;
				const citation: OpenAiWebCitation = {
					url: annotation.url,
				};
				if (typeof annotation.title === "string") citation.title = annotation.title;
				if (typeof annotation.start_index === "number") citation.startIndex = annotation.start_index;
				if (typeof annotation.end_index === "number") citation.endIndex = annotation.end_index;
				citations.push(citation);
			}
		}
	}

	const sources = Array.isArray(record.sources) ? record.sources : [];
	const result: OpenAiWebSearchResult = {
		provider: "openai",
		model: typeof record.model === "string" ? record.model : fallbackModel,
		answer: textParts.join("\n\n").trim(),
		citations: dedupeCitations(citations),
		sources,
		actions,
	};
	if (typeof record.id === "string") result.responseId = record.id;
	if (typeof record.status === "string") result.status = record.status;
	if (record.usage !== undefined) result.usage = record.usage;
	return result;
}

function summarizeOpenAiError(payload: unknown): string {
	if (isRecord(payload)) {
		const error = payload.error;
		if (isRecord(error)) {
			const message = typeof error.message === "string" ? error.message : JSON.stringify(error);
			const code = typeof error.code === "string" ? ` code=${error.code}` : "";
			return `${message}${code}`;
		}
	}
	return typeof payload === "string" ? payload : JSON.stringify(payload);
}

function normalizeDomainList(domains: string[] | undefined): string[] {
	if (domains === undefined) return [];
	const seen = new Set<string>();
	for (const domain of domains) {
		const normalized = domain
			.trim()
			.replace(/^https?:\/\//i, "")
			.replace(/\/.*$/, "")
			.toLowerCase();
		if (normalized.length > 0) seen.add(normalized);
	}
	return [...seen].slice(0, 100);
}

function dedupeCitations(citations: OpenAiWebCitation[]): OpenAiWebCitation[] {
	const byUrl = new Map<string, OpenAiWebCitation>();
	for (const citation of citations) {
		if (!byUrl.has(citation.url)) byUrl.set(citation.url, citation);
	}
	return [...byUrl.values()];
}

async function readPackageJson(path: string): Promise<PackageJson> {
	try {
		const raw = await readFile(path, "utf8");
		const parsed = JSON.parse(raw) as unknown;
		return isRecord(parsed) ? (parsed as PackageJson) : {};
	} catch {
		return {};
	}
}

function hasScript(packageJson: PackageJson, name: string): boolean {
	return typeof packageJson.scripts?.[name] === "string";
}

function resolveClankyRoot(): string {
	return fileURLToPath(new URL("../../../..", import.meta.url));
}

async function resolveExecutable(name: string, env: NodeJS.ProcessEnv): Promise<string | undefined> {
	const pathValue = env.PATH;
	if (pathValue === undefined) return undefined;
	const extensions =
		process.platform === "win32"
			? (env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";").filter((entry) => entry.length > 0)
			: [""];
	for (const dir of pathValue.split(delimiter)) {
		if (dir.length === 0) continue;
		for (const extension of extensions) {
			const candidate = join(dir, `${name}${extension}`);
			if (!existsSync(candidate)) continue;
			try {
				await access(candidate, constants.X_OK);
				return candidate;
			} catch {}
		}
	}
	return undefined;
}

function dropUndefined<T extends Record<string, unknown>>(value: T): Partial<T> {
	const output: Partial<T> = {};
	for (const [key, entry] of Object.entries(value)) {
		if (entry !== undefined && entry !== "") output[key as keyof T] = entry as T[keyof T];
	}
	return output;
}
