import { appendFile, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
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

export async function startBrowserBridgeServer(options: BrowserBridgeServerOptions = {}): Promise<() => Promise<void>> {
	const env = options.env ?? process.env;
	const paths = resolveBrowserBridgePaths({
		...(options.homeDir === undefined ? {} : { homeDir: options.homeDir }),
		env,
	});
	const config = await loadPersistedConfig(paths.configFile);
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
			res.writeHead(200, { "content-type": "application/json" });
			res.end(
				JSON.stringify({
					ok: true,
					connectedBrowsers: [...clients].map((entry) => entry.browser),
					connectionCount: clients.size,
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
		res.writeHead(404, { "content-type": "application/json" });
		res.end(JSON.stringify({ error: "not_found" }));
	}

	function attachAgent(socket: WebSocket): void {
		const agent: AgentClient = {
			socket,
			browser: "unknown",
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
		const connectedBrowsers = [...clients].map((agent) => ({ browser: agent.browser, connectedAt: agent.connectedAt }));
		const browser = connectedBrowsers[0]?.browser ?? (clients.size === 0 ? "disconnected" : "unknown");
		const state = {
			port,
			pid: process.pid,
			secret: token,
			browser,
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
