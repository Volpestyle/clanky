import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { resolveClankyHome } from "./paths.ts";

export type BrowserBridgeOp =
	| "status"
	| "open_tab"
	| "navigate"
	| "list_tabs"
	| "close_tab"
	| "snapshot"
	| "read_text"
	| "query"
	| "eval"
	| "fill"
	| "wait_for"
	| "screenshot"
	| "click"
	| "double_click"
	| "type"
	| "key"
	| "scroll"
	| "drag"
	| "hover"
	| "back"
	| "forward"
	| "reload"
	| "wait";

export interface BrowserBridgeState {
	port: number;
	pid: number;
	secret?: string;
	browser?: string;
	startedAt?: string;
	expectedExtensionVersion?: string;
	connectedBrowsers?: BrowserBridgeConnectionSummary[];
}

export interface BrowserBridgeConnectionSummary {
	browser?: string;
	version?: string;
	stale?: boolean;
	connectedAt?: string;
}

export interface BrowserBridgeRequest {
	op: BrowserBridgeOp;
	params?: Record<string, unknown>;
}

const ROUTES: Record<Exclude<BrowserBridgeOp, "status">, { path: string; map?: (params: Record<string, unknown>) => Record<string, unknown> }> = {
	open_tab: { path: "/tabs" },
	navigate: { path: "/tabs/navigate" },
	list_tabs: { path: "/tabs/list" },
	close_tab: { path: "/tabs/close" },
	snapshot: { path: "/snapshot" },
	read_text: { path: "/read-text" },
	query: { path: "/query" },
	eval: { path: "/eval" },
	fill: { path: "/fill" },
	wait_for: { path: "/wait-for" },
	screenshot: { path: "/screenshot" },
	click: { path: "/input/click" },
	double_click: { path: "/input/double-click" },
	type: { path: "/input/type" },
	key: { path: "/input/key" },
	scroll: { path: "/input/scroll" },
	drag: { path: "/input/drag" },
	hover: { path: "/input/hover" },
	back: { path: "/tabs/back" },
	forward: { path: "/tabs/forward" },
	reload: { path: "/tabs/reload" },
	wait: { path: "/wait" },
};

export async function browserBridgeStatus(fetchImpl: typeof fetch = fetch): Promise<Record<string, unknown>> {
	const paths = browserBridgePaths(process.env);
	const config = await readBrowserBridgeConfig(paths.configFile);
	const extension = await readBrowserBridgeExtensionStatus(paths.extensionDir);
	const stateResult = await tryReadBrowserBridgeState(process.env);
	if (!stateResult.ok) {
		return {
			available: false,
			daemonRunning: false,
			extensionConnected: false,
			paths,
			config,
			extension,
			state: { ok: false, error: stateResult.error },
			nextSteps: browserBridgeNextSteps({ configOk: config.ok, stateOk: false, daemonRunning: false, extensionConnected: false }),
		};
	}
	const state = stateResult.state;
	const health = await fetchHealth(state, fetchImpl);
	const healthRecord = isRecord(health) ? health : {};
	const daemonRunning = healthRecord.ok === true;
	const connectionCount = typeof healthRecord.connectionCount === "number" ? healthRecord.connectionCount : 0;
	const extensionConnected = daemonRunning && connectionCount > 0;
	const stale = Array.isArray(healthRecord.extensions) && healthRecord.extensions.some((entry) => isRecord(entry) && entry.stale === true);
	return {
		available: daemonRunning && extensionConnected && !stale,
		daemonRunning,
		extensionConnected,
		paths,
		config,
		extension,
		state: { ok: true, ...redactState(state) },
		health,
		nextSteps: browserBridgeNextSteps({ configOk: config.ok, stateOk: true, daemonRunning, extensionConnected, stale }),
	};
}

export async function callBrowserBridge(input: BrowserBridgeRequest, fetchImpl: typeof fetch = fetch): Promise<unknown> {
	if (input.op === "status") return await browserBridgeStatus(fetchImpl);
	const route = ROUTES[input.op];
	const state = await readBrowserBridgeState();
	if (state.secret === undefined || state.secret.length === 0) {
		throw new Error("browser bridge state is missing its secret; restart the bridge daemon");
	}
	const response = await fetchImpl(`http://127.0.0.1:${state.port}${route.path}`, {
		method: "POST",
		headers: { "content-type": "application/json", "x-clanky-token": state.secret },
		body: JSON.stringify(input.params ?? {}),
	});
	const text = await response.text();
	if (!response.ok) throw new Error(`browser bridge ${input.op} failed (${response.status}): ${text.slice(0, 500)}`);
	if (text.length === 0) return {};
	try {
		return JSON.parse(text) as unknown;
	} catch {
		return { raw: text };
	}
}

async function readBrowserBridgeState(env: NodeJS.ProcessEnv = process.env): Promise<BrowserBridgeState> {
	const path = browserBridgePaths(env).stateFile;
	let parsed: unknown;
	try {
		parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
	} catch {
		throw new Error(
			`browser bridge is not available at ${path}; install/start the bridge daemon and load the unpacked extension`,
		);
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("browser bridge state is malformed");
	const record = parsed as Record<string, unknown>;
	if (typeof record.port !== "number" || typeof record.pid !== "number") throw new Error("browser bridge state is missing port/pid");
	return {
		port: record.port,
		pid: record.pid,
		...(typeof record.secret === "string" ? { secret: record.secret } : {}),
		...(typeof record.browser === "string" ? { browser: record.browser } : {}),
		...(typeof record.startedAt === "string" ? { startedAt: record.startedAt } : {}),
		...(typeof record.expectedExtensionVersion === "string" ? { expectedExtensionVersion: record.expectedExtensionVersion } : {}),
		...(Array.isArray(record.connectedBrowsers)
			? { connectedBrowsers: record.connectedBrowsers.flatMap(formatConnectionSummary) }
			: {}),
	};
}

async function fetchHealth(state: BrowserBridgeState, fetchImpl: typeof fetch): Promise<unknown> {
	try {
		const response = await fetchImpl(`http://127.0.0.1:${state.port}/healthz`);
		return await response.json();
	} catch (error) {
		return { ok: false, error: error instanceof Error ? error.message : String(error) };
	}
}

function redactState(state: BrowserBridgeState): Omit<BrowserBridgeState, "secret"> & { hasSecret: boolean } {
	return {
		port: state.port,
		pid: state.pid,
		hasSecret: state.secret !== undefined && state.secret.length > 0,
		...(state.browser === undefined ? {} : { browser: state.browser }),
		...(state.startedAt === undefined ? {} : { startedAt: state.startedAt }),
		...(state.expectedExtensionVersion === undefined ? {} : { expectedExtensionVersion: state.expectedExtensionVersion }),
		...(state.connectedBrowsers === undefined ? {} : { connectedBrowsers: state.connectedBrowsers }),
	};
}

function browserBridgePaths(env: NodeJS.ProcessEnv): {
	homeDir: string;
	bridgeDir: string;
	configFile: string;
	stateFile: string;
	extensionDir: string;
	serverLogFile: string;
} {
	const homeDir = resolveClankyHome(env);
	const bridgeDir = join(homeDir, "browser-bridge");
	return {
		homeDir,
		bridgeDir,
		configFile: join(bridgeDir, "config.json"),
		stateFile: join(bridgeDir, "state.json"),
		extensionDir: join(bridgeDir, "extension"),
		serverLogFile: join(bridgeDir, "server.log"),
	};
}

async function tryReadBrowserBridgeState(
	env: NodeJS.ProcessEnv,
): Promise<{ ok: true; state: BrowserBridgeState } | { ok: false; error: string }> {
	try {
		return { ok: true, state: await readBrowserBridgeState(env) };
	} catch (error) {
		return { ok: false, error: error instanceof Error ? error.message : String(error) };
	}
}

async function readBrowserBridgeConfig(configFile: string): Promise<Record<string, unknown>> {
	try {
		const parsed = JSON.parse(await readFile(configFile, "utf8")) as unknown;
		if (!isRecord(parsed)) return { ok: false, configFile, error: "config is not an object" };
		return {
			ok: typeof parsed.port === "number" && typeof parsed.token === "string" && parsed.token.length > 0,
			configFile,
			...(typeof parsed.port === "number" ? { port: parsed.port } : {}),
			hasToken: typeof parsed.token === "string" && parsed.token.length > 0,
		};
	} catch (error) {
		return { ok: false, configFile, error: error instanceof Error ? error.message : String(error) };
	}
}

async function readBrowserBridgeExtensionStatus(extensionDir: string): Promise<Record<string, unknown>> {
	const manifestFile = join(extensionDir, "manifest.json");
	const configFile = join(extensionDir, "config.json");
	const manifest = await readJsonRecord(manifestFile);
	const config = await readJsonRecord(configFile);
	return {
		extensionDir,
		manifestFile,
		configFile,
		manifestPresent: manifest.ok,
		configPresent: config.ok,
		...(manifest.ok && typeof manifest.value.name === "string" ? { name: manifest.value.name } : {}),
		...(manifest.ok && typeof manifest.value.version === "string" ? { version: manifest.value.version } : {}),
		hasBundledToken: config.ok && typeof config.value.token === "string" && config.value.token.length > 0,
		...(config.ok && typeof config.value.port === "number" ? { port: config.value.port } : {}),
	};
}

async function readJsonRecord(path: string): Promise<{ ok: true; value: Record<string, unknown> } | { ok: false }> {
	try {
		const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
		return isRecord(parsed) ? { ok: true, value: parsed } : { ok: false };
	} catch {
		return { ok: false };
	}
}

function browserBridgeNextSteps(input: {
	configOk: unknown;
	stateOk: boolean;
	daemonRunning: boolean;
	extensionConnected: boolean;
	stale?: boolean;
}): string[] {
	if (input.configOk !== true) return ["Run pnpm browser-bridge:install."];
	if (!input.stateOk || !input.daemonRunning) return ["Start the daemon with pnpm browser-bridge:serve."];
	if (!input.extensionConnected) return ["Load or reload the unpacked extension from the reported extensionDir in Helium/Chrome/Brave."];
	if (input.stale === true) return ["Reload the unpacked browser extension so its version matches the packaged bridge."];
	return [];
}

function formatConnectionSummary(value: unknown): BrowserBridgeConnectionSummary[] {
	if (!isRecord(value)) return [];
	return [
		{
			...(typeof value.browser === "string" ? { browser: value.browser } : {}),
			...(typeof value.version === "string" ? { version: value.version } : {}),
			...(typeof value.stale === "boolean" ? { stale: value.stale } : {}),
			...(typeof value.connectedAt === "string" ? { connectedAt: value.connectedAt } : {}),
		},
	];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
