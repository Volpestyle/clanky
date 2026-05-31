import { appendFile, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { type WebSocket, WebSocketServer } from "ws";
import { resolveBrowserBridgePaths } from "./paths.ts";

export interface BrowserBridgeServerOptions {
	homeDir?: string;
	env?: NodeJS.ProcessEnv;
	host?: string;
	port?: number;
}

interface PersistedConfig {
	port: number;
	token: string;
}

interface AgentClient {
	socket: WebSocket;
	browser: string;
	version: string;
	connectedAt: string;
	pingTimer: ReturnType<typeof setInterval>;
}

interface PendingCall {
	resolve: (value: unknown) => void;
	reject: (error: Error) => void;
	timer: ReturnType<typeof setTimeout>;
}

interface OpenTabRequest {
	url: string;
	active?: boolean;
}

const SHORT_OP_TIMEOUT_MS = 5_000;
const NAVIGATE_OP_TIMEOUT_MS = 15_000;
const WAIT_OP_MAX_MS = 30_000;
const EVAL_OP_TIMEOUT_MS = 20_000;
// wait_for caps its own poll loop at 30s; allow daemon-side headroom on top.
const WAIT_FOR_OP_TIMEOUT_MS = 35_000;

export async function startBrowserBridgeServer(options: BrowserBridgeServerOptions = {}): Promise<() => Promise<void>> {
	const env = options.env ?? process.env;
	const paths = resolveBrowserBridgePaths({
		...(options.homeDir === undefined ? {} : { homeDir: options.homeDir }),
		env,
	});
	const config = await loadPersistedConfig(paths.configFile);
	// Re-read on demand so that upgrading the package (which bumps the packaged
	// manifest version) is reflected without a daemon restart — otherwise a newer
	// reloaded extension would be falsely flagged stale against a boot-time value.
	let expectedExtensionVersion = await readPackagedExtensionVersion();
	const port = options.port ?? config.port;
	const host = options.host ?? "127.0.0.1";
	const token = config.token;
	const clients = new Set<AgentClient>();
	const pending = new Map<number, PendingCall>();
	let nextId = 1;

	await mkdir(paths.bridgeDir, { recursive: true });
	const startedAt = new Date().toISOString();

	const log = async (line: string): Promise<void> => {
		try {
			await appendFile(paths.serverLogFile, `${new Date().toISOString()} ${line}\n`);
		} catch {
			// swallow
		}
	};

	const httpServer = createServer((req, res) => {
		void handleHttp(req, res).catch((error: unknown) => {
			const message = error instanceof Error ? error.message : String(error);
			void log(`http handler error: ${message}`);
			if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
			res.end(JSON.stringify({ error: message }));
		});
	});

	const wsServer = new WebSocketServer({ noServer: true });

	httpServer.on("upgrade", (req, socket, head) => {
		const requestUrl = new URL(req.url ?? "/", "http://127.0.0.1");
		if (requestUrl.pathname !== "/agent") {
			socket.destroy();
			return;
		}
		const queryToken = requestUrl.searchParams.get("token");
		if (queryToken !== token) {
			socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
			socket.destroy();
			return;
		}
		wsServer.handleUpgrade(req, socket, head, (ws) => {
			attachAgent(ws);
		});
	});

	async function handleHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
		const url = new URL(req.url ?? "/", "http://127.0.0.1");
		if (url.pathname === "/healthz") {
			// Refresh the packaged version so stale detection tracks package upgrades live.
			expectedExtensionVersion = await readPackagedExtensionVersion();
			res.writeHead(200, { "content-type": "application/json" });
			res.end(
				JSON.stringify({
					ok: true,
					connectedBrowsers: [...clients].map((entry) => entry.browser),
					connectionCount: clients.size,
					expectedExtensionVersion,
					extensions: [...clients].map((entry) => ({
						browser: entry.browser,
						version: entry.version,
						stale: entry.version !== "unknown" && entry.version !== expectedExtensionVersion,
					})),
				}),
			);
			return;
		}
		if (req.headers["x-clanky-token"] !== token) {
			res.writeHead(401, { "content-type": "application/json" });
			res.end(JSON.stringify({ error: "unauthorized" }));
			return;
		}
		if (req.method !== "POST") {
			res.writeHead(405);
			res.end();
			return;
		}
		const body = await readRequestBody(req);
		const parsed = parseJsonBody(body);
		if (url.pathname === "/tabs") {
			const result = await dispatch("open_tab", parsed as OpenTabRequest, 15_000);
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify(result));
			return;
		}
		if (url.pathname === "/screenshot") {
			const params = requireRecord(parsed, "screenshot");
			const tabId = optionalNumber(params, "tabId", "screenshot");
			const result = await dispatch("screenshot", tabId === undefined ? {} : { tabId }, SHORT_OP_TIMEOUT_MS);
			respondJson(res, 200, result);
			return;
		}
		if (url.pathname === "/tabs/list") {
			const result = await dispatch("list_tabs", {}, SHORT_OP_TIMEOUT_MS);
			respondJson(res, 200, result);
			return;
		}
		if (url.pathname === "/read-text") {
			const params = requireRecord(parsed, "read_text");
			const tabId = requireNumber(params, "tabId", "read_text");
			const payload: Record<string, unknown> = { tabId };
			const maxChars = optionalNumber(params, "maxChars", "read_text");
			if (maxChars !== undefined) payload.maxChars = maxChars;
			const result = await dispatch("read_text", payload, SHORT_OP_TIMEOUT_MS);
			respondJson(res, 200, result);
			return;
		}
		if (url.pathname === "/tabs/navigate") {
			const params = requireRecord(parsed, "navigate");
			const urlValue = requireString(params, "url", "navigate");
			const tabId = optionalNumber(params, "tabId", "navigate");
			const payload: Record<string, unknown> = { url: urlValue };
			if (tabId !== undefined) payload.tabId = tabId;
			const result = await dispatch("navigate", payload, NAVIGATE_OP_TIMEOUT_MS);
			respondJson(res, 200, result);
			return;
		}
		if (url.pathname === "/tabs/close") {
			const params = requireRecord(parsed, "close_tab");
			const tabId = requireNumber(params, "tabId", "close_tab");
			const result = await dispatch("close_tab", { tabId }, SHORT_OP_TIMEOUT_MS);
			respondJson(res, 200, result);
			return;
		}
		if (url.pathname === "/input/click") {
			const params = requireRecord(parsed, "click");
			const tabId = requireNumber(params, "tabId", "click");
			const x = requireNumber(params, "x", "click");
			const y = requireNumber(params, "y", "click");
			const payload: Record<string, unknown> = { tabId, x, y };
			const button = optionalMouseButton(params, "click");
			if (button !== undefined) payload.button = button;
			const clickCount = optionalNumber(params, "clickCount", "click");
			if (clickCount !== undefined) payload.clickCount = clickCount;
			const result = await dispatch("click", payload, SHORT_OP_TIMEOUT_MS);
			respondJson(res, 200, result);
			return;
		}
		if (url.pathname === "/input/double-click") {
			const params = requireRecord(parsed, "double_click");
			const tabId = requireNumber(params, "tabId", "double_click");
			const x = requireNumber(params, "x", "double_click");
			const y = requireNumber(params, "y", "double_click");
			const payload: Record<string, unknown> = { tabId, x, y };
			const button = optionalMouseButton(params, "double_click");
			if (button !== undefined) payload.button = button;
			const result = await dispatch("double_click", payload, SHORT_OP_TIMEOUT_MS);
			respondJson(res, 200, result);
			return;
		}
		if (url.pathname === "/input/type") {
			const params = requireRecord(parsed, "type");
			const tabId = requireNumber(params, "tabId", "type");
			const text = requireString(params, "text", "type");
			const result = await dispatch("type", { tabId, text }, SHORT_OP_TIMEOUT_MS);
			respondJson(res, 200, result);
			return;
		}
		if (url.pathname === "/input/key") {
			const params = requireRecord(parsed, "key");
			const tabId = requireNumber(params, "tabId", "key");
			const key = requireString(params, "key", "key");
			const payload: Record<string, unknown> = { tabId, key };
			const modifiers = optionalKeyModifiers(params, "key");
			if (modifiers !== undefined) payload.modifiers = modifiers;
			const result = await dispatch("key", payload, SHORT_OP_TIMEOUT_MS);
			respondJson(res, 200, result);
			return;
		}
		if (url.pathname === "/input/hover") {
			const params = requireRecord(parsed, "hover");
			const tabId = requireNumber(params, "tabId", "hover");
			const x = requireNumber(params, "x", "hover");
			const y = requireNumber(params, "y", "hover");
			const result = await dispatch("hover", { tabId, x, y }, SHORT_OP_TIMEOUT_MS);
			respondJson(res, 200, result);
			return;
		}
		if (url.pathname === "/input/scroll") {
			const params = requireRecord(parsed, "scroll");
			const tabId = requireNumber(params, "tabId", "scroll");
			const x = requireNumber(params, "x", "scroll");
			const y = requireNumber(params, "y", "scroll");
			const deltaX = requireNumber(params, "deltaX", "scroll");
			const deltaY = requireNumber(params, "deltaY", "scroll");
			const result = await dispatch("scroll", { tabId, x, y, deltaX, deltaY }, SHORT_OP_TIMEOUT_MS);
			respondJson(res, 200, result);
			return;
		}
		if (url.pathname === "/wait") {
			const params = requireRecord(parsed, "wait");
			const ms = requireNumber(params, "ms", "wait");
			if (ms < 0 || !Number.isFinite(ms)) {
				throw new Error("wait ms must be a non-negative finite number.");
			}
			if (ms > WAIT_OP_MAX_MS) {
				throw new Error(`wait ms must be <= ${WAIT_OP_MAX_MS}.`);
			}
			await new Promise<void>((resolve) => {
				setTimeout(resolve, ms);
			});
			respondJson(res, 200, { ok: true, waitedMs: ms });
			return;
		}
		if (url.pathname === "/eval") {
			const params = requireRecord(parsed, "eval");
			const tabId = requireNumber(params, "tabId", "eval");
			const expression = requireString(params, "expression", "eval");
			const payload: Record<string, unknown> = { tabId, expression };
			if (params.awaitPromise !== undefined) payload.awaitPromise = params.awaitPromise === true;
			const result = await dispatch("eval", payload, EVAL_OP_TIMEOUT_MS);
			respondJson(res, 200, result);
			return;
		}
		if (url.pathname === "/fill") {
			const params = requireRecord(parsed, "fill");
			const tabId = requireNumber(params, "tabId", "fill");
			const selector = requireString(params, "selector", "fill");
			const value = params.value;
			if (typeof value !== "string") {
				throw new Error('fill requires a string "value".');
			}
			const result = await dispatch("fill", { tabId, selector, value }, SHORT_OP_TIMEOUT_MS);
			respondJson(res, 200, result);
			return;
		}
		if (url.pathname === "/query") {
			const params = requireRecord(parsed, "query");
			const tabId = requireNumber(params, "tabId", "query");
			const selector = requireString(params, "selector", "query");
			const payload: Record<string, unknown> = { tabId, selector };
			if (params.all !== undefined) payload.all = params.all === true;
			if (params.scrollIntoView !== undefined) payload.scrollIntoView = params.scrollIntoView === true;
			const result = await dispatch("query", payload, SHORT_OP_TIMEOUT_MS);
			respondJson(res, 200, result);
			return;
		}
		if (url.pathname === "/wait-for") {
			const params = requireRecord(parsed, "wait_for");
			const tabId = requireNumber(params, "tabId", "wait_for");
			const payload: Record<string, unknown> = { tabId };
			const selector = optionalString(params, "selector", "wait_for");
			if (selector !== undefined) payload.selector = selector;
			const jsCondition = optionalString(params, "jsCondition", "wait_for");
			if (jsCondition !== undefined) payload.jsCondition = jsCondition;
			const readyState = optionalString(params, "readyState", "wait_for");
			if (readyState !== undefined) payload.readyState = readyState;
			if (params.visible !== undefined) payload.visible = params.visible === true;
			const timeoutMs = optionalNumber(params, "timeoutMs", "wait_for");
			if (timeoutMs !== undefined) payload.timeoutMs = timeoutMs;
			const pollMs = optionalNumber(params, "pollMs", "wait_for");
			if (pollMs !== undefined) payload.pollMs = pollMs;
			const result = await dispatch("wait_for", payload, WAIT_FOR_OP_TIMEOUT_MS);
			respondJson(res, 200, result);
			return;
		}
		if (url.pathname === "/tabs/back" || url.pathname === "/tabs/forward" || url.pathname === "/tabs/reload") {
			const opName = url.pathname === "/tabs/back" ? "back" : url.pathname === "/tabs/forward" ? "forward" : "reload";
			const params = requireRecord(parsed, opName);
			const tabId = requireNumber(params, "tabId", opName);
			const payload: Record<string, unknown> = { tabId };
			if (opName === "reload" && params.bypassCache !== undefined) payload.bypassCache = params.bypassCache === true;
			const result = await dispatch(opName, payload, NAVIGATE_OP_TIMEOUT_MS);
			respondJson(res, 200, result);
			return;
		}
		res.writeHead(404, { "content-type": "application/json" });
		res.end(JSON.stringify({ error: "not_found" }));
	}

	function attachAgent(socket: WebSocket): void {
		const agent: AgentClient = {
			socket,
			browser: "unknown",
			version: "unknown",
			connectedAt: new Date().toISOString(),
			pingTimer: setInterval(() => {
				try {
					socket.ping();
				} catch {
					// onclose will clean up
				}
			}, 20_000),
		};
		clients.add(agent);
		void log(`agent connected (${clients.size} total)`);
		void updateStateFile();
		socket.on("message", (data) => {
			let msg: unknown;
			try {
				msg = JSON.parse(data.toString("utf8"));
			} catch {
				return;
			}
			if (!isRecord(msg)) return;
			if (msg.type === "hello" && typeof msg.browser === "string") {
				agent.browser = msg.browser;
				if (typeof msg.version === "string") agent.version = msg.version;
				void updateStateFile();
				return;
			}
			if (typeof msg.id === "number" && pending.has(msg.id)) {
				const entry = pending.get(msg.id);
				if (entry === undefined) return;
				pending.delete(msg.id);
				clearTimeout(entry.timer);
				if (msg.ok === false) {
					entry.reject(new Error(typeof msg.error === "string" ? msg.error : "extension reported error"));
				} else {
					entry.resolve(msg.result);
				}
			}
		});
		socket.on("close", () => {
			clearInterval(agent.pingTimer);
			clients.delete(agent);
			void log(`agent disconnected (${clients.size} total)`);
			void updateStateFile();
		});
		socket.on("error", (error: Error) => {
			void log(`agent socket error: ${error.message}`);
		});
	}

	async function dispatch(op: string, params: unknown, timeoutMs: number): Promise<unknown> {
		const agent = pickAgent();
		if (agent === undefined) {
			throw new Error("no browser extension is connected to the Clanky browser bridge.");
		}
		const id = nextId++;
		return await new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				if (pending.has(id)) {
					pending.delete(id);
					reject(new Error(`extension did not respond to ${op} within ${timeoutMs}ms`));
				}
			}, timeoutMs);
			pending.set(id, { resolve, reject, timer });
			try {
				agent.socket.send(JSON.stringify({ id, op, ...(isRecord(params) ? params : {}) }));
			} catch (error) {
				pending.delete(id);
				clearTimeout(timer);
				reject(error instanceof Error ? error : new Error(String(error)));
			}
		});
	}

	function pickAgent(): AgentClient | undefined {
		for (const agent of clients) return agent;
		return undefined;
	}

	async function updateStateFile(): Promise<void> {
		const connectedBrowsers = [...clients].map((agent) => ({
			browser: agent.browser,
			version: agent.version,
			stale: agent.version !== "unknown" && agent.version !== expectedExtensionVersion,
			connectedAt: agent.connectedAt,
		}));
		const browser = connectedBrowsers[0]?.browser ?? (clients.size === 0 ? "disconnected" : "unknown");
		const state = {
			port,
			pid: process.pid,
			secret: token,
			browser,
			expectedExtensionVersion,
			startedAt,
			connectedBrowsers,
		};
		try {
			await writeFile(paths.stateFile, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			await log(`state write failed: ${message}`);
		}
	}

	await new Promise<void>((resolve, reject) => {
		const onError = (error: NodeJS.ErrnoException): void => {
			httpServer.off("listening", onListening);
			if (error.code === "EADDRINUSE") {
				reject(
					new Error(
						`port ${port} is already in use; set CLANKY_BROWSER_BRIDGE_PORT to a free port (and re-run pnpm browser-bridge:install so the extension picks up the new port).`,
					),
				);
				return;
			}
			reject(error);
		};
		const onListening = (): void => {
			httpServer.off("error", onError);
			resolve();
		};
		httpServer.once("error", onError);
		httpServer.once("listening", onListening);
		httpServer.listen(port, host);
	});

	const address = httpServer.address() as AddressInfo | string | null;
	const actualPort = address && typeof address === "object" ? address.port : port;
	await log(`bridge server listening on ${host}:${actualPort}`);
	await updateStateFile();

	let shuttingDown = false;
	const shutdown = async (): Promise<void> => {
		if (shuttingDown) return;
		shuttingDown = true;
		await log("bridge server shutting down");
		for (const entry of pending.values()) {
			clearTimeout(entry.timer);
			entry.reject(new Error("bridge server is shutting down"));
		}
		pending.clear();
		for (const agent of clients) {
			clearInterval(agent.pingTimer);
			try {
				agent.socket.close();
			} catch {
				// ignore
			}
		}
		clients.clear();
		await new Promise<void>((resolve) => {
			wsServer.close(() => resolve());
		});
		await new Promise<void>((resolve) => {
			httpServer.close(() => resolve());
		});
		try {
			await unlink(paths.stateFile);
		} catch {
			// state already gone
		}
	};
	const onSignal = (): void => {
		void shutdown().then(() => process.exit(0));
	};
	process.once("SIGTERM", onSignal);
	process.once("SIGINT", onSignal);

	return shutdown;
}

async function readPackagedExtensionVersion(): Promise<string> {
	try {
		const manifestPath = fileURLToPath(new URL("../extension/manifest.template.json", import.meta.url));
		const raw = await readFile(manifestPath, "utf8");
		const parsed: unknown = JSON.parse(raw);
		if (isRecord(parsed) && typeof parsed.version === "string") return parsed.version;
	} catch {
		// fall through to unknown
	}
	return "unknown";
}

async function loadPersistedConfig(configFile: string): Promise<PersistedConfig> {
	let raw: string;
	try {
		raw = await readFile(configFile, "utf8");
	} catch {
		throw new Error(`browser bridge config not found at ${configFile}. Run "pnpm browser-bridge:install" first.`);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw new Error(`browser bridge config at ${configFile} is not valid JSON.`);
	}
	if (!isRecord(parsed)) {
		throw new Error(`browser bridge config at ${configFile} is not an object.`);
	}
	const port = parsed.port;
	const token = parsed.token;
	if (typeof port !== "number" || typeof token !== "string" || token.length === 0) {
		throw new Error(
			`browser bridge config at ${configFile} is missing port or token. Re-run pnpm browser-bridge:install.`,
		);
	}
	return { port, token };
}

async function readRequestBody(req: IncomingMessage): Promise<string> {
	let total = 0;
	const chunks: Buffer[] = [];
	for await (const chunk of req) {
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		total += buffer.length;
		if (total > 256 * 1024) throw new Error("request body too large");
		chunks.push(buffer);
	}
	return Buffer.concat(chunks).toString("utf8");
}

function parseJsonBody(body: string): unknown {
	if (body.length === 0) return {};
	try {
		return JSON.parse(body);
	} catch {
		throw new Error("invalid JSON body");
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function respondJson(res: ServerResponse, status: number, body: unknown): void {
	res.writeHead(status, { "content-type": "application/json" });
	res.end(JSON.stringify(body));
}

function requireRecord(value: unknown, opName: string): Record<string, unknown> {
	if (!isRecord(value)) {
		throw new Error(`${opName} requires a JSON object body.`);
	}
	return value;
}

function requireNumber(record: Record<string, unknown>, field: string, opName: string): number {
	const value = record[field];
	if (typeof value !== "number" || !Number.isFinite(value)) {
		throw new Error(`${opName} requires a finite number "${field}".`);
	}
	return value;
}

function optionalNumber(record: Record<string, unknown>, field: string, opName: string): number | undefined {
	const value = record[field];
	if (value === undefined) return undefined;
	if (typeof value !== "number" || !Number.isFinite(value)) {
		throw new Error(`${opName} field "${field}" must be a finite number when provided.`);
	}
	return value;
}

function requireString(record: Record<string, unknown>, field: string, opName: string): string {
	const value = record[field];
	if (typeof value !== "string" || value.length === 0) {
		throw new Error(`${opName} requires a non-empty string "${field}".`);
	}
	return value;
}

function optionalString(record: Record<string, unknown>, field: string, opName: string): string | undefined {
	const value = record[field];
	if (value === undefined) return undefined;
	if (typeof value !== "string" || value.length === 0) {
		throw new Error(`${opName} field "${field}" must be a non-empty string when provided.`);
	}
	return value;
}

function optionalMouseButton(record: Record<string, unknown>, opName: string): "left" | "right" | "middle" | undefined {
	const value = record.button;
	if (value === undefined) return undefined;
	if (value !== "left" && value !== "right" && value !== "middle") {
		throw new Error(`${opName} button must be "left", "right", or "middle".`);
	}
	return value;
}

function optionalKeyModifiers(
	record: Record<string, unknown>,
	opName: string,
): { ctrl?: boolean; shift?: boolean; alt?: boolean; meta?: boolean } | undefined {
	const value = record.modifiers;
	if (value === undefined) return undefined;
	if (!isRecord(value)) {
		throw new Error(`${opName} modifiers must be an object when provided.`);
	}
	const out: { ctrl?: boolean; shift?: boolean; alt?: boolean; meta?: boolean } = {};
	for (const flag of ["ctrl", "shift", "alt", "meta"] as const) {
		const flagValue = value[flag];
		if (flagValue === undefined) continue;
		if (typeof flagValue !== "boolean") {
			throw new Error(`${opName} modifiers.${flag} must be boolean when provided.`);
		}
		out[flag] = flagValue;
	}
	return out;
}
