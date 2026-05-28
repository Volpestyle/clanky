import { readFile } from "node:fs/promises";
import { resolveBrowserBridgePaths } from "./paths.ts";

export interface BrowserBridgeState {
	port: number;
	pid: number;
	secret: string;
	browser?: string;
	startedAt?: string;
}

export interface OpenTabInput {
	url: string;
	active?: boolean;
}

export interface OpenTabResult {
	tabId: number;
	url: string;
	windowId?: number;
	active: boolean;
	browser?: string;
}

export interface BrowserBridgeClientOptions {
	homeDir?: string;
	env?: NodeJS.ProcessEnv;
	fetchImpl?: typeof fetch;
}

export class BrowserBridgeUnavailableError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "BrowserBridgeUnavailableError";
	}
}

export async function loadBrowserBridgeState(options: BrowserBridgeClientOptions = {}): Promise<BrowserBridgeState> {
	const env = options.env ?? process.env;
	const paths = resolveBrowserBridgePaths({
		...(options.homeDir === undefined ? {} : { homeDir: options.homeDir }),
		env,
	});
	let raw: string;
	try {
		raw = await readFile(paths.stateFile, "utf8");
	} catch {
		throw new BrowserBridgeUnavailableError(
			`Browser bridge state file not found at ${paths.stateFile}. Run "pnpm browser-bridge:install" and load the unpacked extension in Helium/Chrome/Brave so the native host can register.`,
		);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw new BrowserBridgeUnavailableError(`Browser bridge state file ${paths.stateFile} is not valid JSON.`);
	}
	if (parsed === null || typeof parsed !== "object") {
		throw new BrowserBridgeUnavailableError(`Browser bridge state file ${paths.stateFile} is not an object.`);
	}
	const record = parsed as Record<string, unknown>;
	const port = record.port;
	const pid = record.pid;
	const secret = record.secret;
	if (typeof port !== "number" || typeof pid !== "number" || typeof secret !== "string") {
		throw new BrowserBridgeUnavailableError(
			`Browser bridge state at ${paths.stateFile} is missing required fields (port/pid/secret). Reopen the extension in your browser to re-register.`,
		);
	}
	return {
		port,
		pid,
		secret,
		...(typeof record.browser === "string" ? { browser: record.browser } : {}),
		...(typeof record.startedAt === "string" ? { startedAt: record.startedAt } : {}),
	};
}

export async function browserOpenTab(
	input: OpenTabInput,
	options: BrowserBridgeClientOptions = {},
): Promise<OpenTabResult> {
	if (typeof input.url !== "string" || input.url.trim().length === 0) {
		throw new Error("browser_open_tab requires a non-empty url.");
	}
	const url = input.url.trim();
	if (!/^https?:\/\//i.test(url) && !url.startsWith("about:") && !url.startsWith("chrome://")) {
		throw new Error("browser_open_tab url must be http(s), about:, or chrome://.");
	}
	const state = await loadBrowserBridgeState(options);
	const fetchImpl = options.fetchImpl ?? fetch;
	const response = await fetchImpl(`http://127.0.0.1:${state.port}/tabs`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			"x-clanky-token": state.secret,
		},
		body: JSON.stringify({ url, active: input.active ?? true }),
	});
	const bodyText = await response.text();
	if (!response.ok) {
		throw new BrowserBridgeUnavailableError(
			`Browser bridge open_tab failed (${response.status}): ${bodyText.slice(0, 400)}`,
		);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(bodyText);
	} catch {
		throw new BrowserBridgeUnavailableError(`Browser bridge returned non-JSON response: ${bodyText.slice(0, 200)}`);
	}
	if (parsed === null || typeof parsed !== "object") {
		throw new BrowserBridgeUnavailableError("Browser bridge returned an unexpected response shape.");
	}
	const record = parsed as Record<string, unknown>;
	const tabId = record.tabId;
	const tabUrl = record.url;
	if (typeof tabId !== "number" || typeof tabUrl !== "string") {
		throw new BrowserBridgeUnavailableError(
			`Browser bridge returned malformed open_tab result: ${bodyText.slice(0, 200)}`,
		);
	}
	return {
		tabId,
		url: tabUrl,
		active: record.active === true,
		...(typeof record.windowId === "number" ? { windowId: record.windowId } : {}),
		...(typeof record.browser === "string"
			? { browser: record.browser }
			: { ...(state.browser === undefined ? {} : { browser: state.browser }) }),
	};
}
