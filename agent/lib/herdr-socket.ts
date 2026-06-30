import { createConnection, type Socket } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";

const SOCKET_TIMEOUT_MS = 30_000;

export interface HerdrRequest {
	id: string;
	method: string;
	params: Record<string, unknown>;
}

export interface HerdrStream {
	close(): void;
}

/// Resolve the herdr api socket for a request. An explicit `session` (a session
/// name, the literal "default", or an absolute socket path) overrides the
/// process env, enabling per-request targeting of any herdr session on the host.
/// When omitted, falls back to the env-bound session the relay was started with.
export function herdrSocketPath(session?: string): string {
	const explicit = session?.trim();
	if (explicit) return resolveSessionSocketPath(explicit);
	if (process.env.HERDR_SOCKET_PATH) return process.env.HERDR_SOCKET_PATH;
	const envSession = process.env.HERDR_SESSION;
	if (envSession && envSession !== "default") {
		return join(homedir(), ".config", "herdr", "sessions", envSession, "herdr.sock");
	}
	return join(homedir(), ".config", "herdr", "herdr.sock");
}

/// Map a session token to its api socket. A value that already looks like a path
/// (contains a slash or ends in .sock) is used verbatim; "default" maps to the
/// top-level socket; any other name maps to sessions/<name>/herdr.sock.
function resolveSessionSocketPath(session: string): string {
	if (session.includes("/") || session.endsWith(".sock")) return session;
	if (session === "default") return join(homedir(), ".config", "herdr", "herdr.sock");
	return join(homedir(), ".config", "herdr", "sessions", session, "herdr.sock");
}

export function herdrClientSocketPath(session?: string): string {
	const explicit = session?.trim();
	if (explicit) return deriveClientSocketPath(herdrSocketPath(explicit));
	if (process.env.HERDR_SOCKET_PATH) return deriveClientSocketPath(process.env.HERDR_SOCKET_PATH);
	if (process.env.HERDR_CLIENT_SOCKET_PATH) return process.env.HERDR_CLIENT_SOCKET_PATH;
	return deriveClientSocketPath(herdrSocketPath());
}

function deriveClientSocketPath(apiSocketPath: string): string {
	return apiSocketPath.endsWith(".sock") ? `${apiSocketPath.slice(0, -".sock".length)}-client.sock` : `${apiSocketPath}-client.sock`;
}

export function herdrRequest(method: string, params: Record<string, unknown> = {}, session?: string): Promise<unknown> {
	const id = `eve_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
	return herdrRequestLine({ id, method, params }, session).then((line) => {
		const envelope = JSON.parse(line) as { result?: unknown; error?: { message?: string; code?: string } };
		if (envelope.error) {
			throw new Error(envelope.error.message ?? envelope.error.code ?? "herdr request failed");
		}
		return envelope.result;
	});
}

export function herdrRequestLine(request: HerdrRequest, session?: string): Promise<string> {
	return new Promise((resolve, reject) => {
		const socket = createConnection(herdrSocketPath(session));
		let buffer = "";
		let settled = false;
		const fail = (error: Error) => {
			if (settled) return;
			settled = true;
			socket.destroy();
			reject(error);
		};
		socket.setTimeout(SOCKET_TIMEOUT_MS, () => fail(new Error("herdr socket request timed out")));
		socket.on("error", fail);
		socket.on("connect", () => {
			socket.write(`${JSON.stringify(request)}\n`);
		});
		socket.on("data", (chunk) => {
			buffer += chunk.toString("utf8");
			const newline = buffer.indexOf("\n");
			if (newline === -1) return;
			const line = buffer.slice(0, newline).trimEnd();
			if (settled) return;
			settled = true;
			socket.end();
			resolve(line);
		});
		socket.on("close", () => {
			if (!settled) fail(new Error("herdr socket closed before responding"));
		});
	});
}

export function herdrStreamLines(
	request: HerdrRequest,
	onLine: (line: string) => void,
	onError: (error: Error) => void,
	onClose?: () => void,
	session?: string,
): HerdrStream {
	const socket: Socket = createConnection(herdrSocketPath(session));
	let buffer = "";
	let closed = false;
	let errored = false;
	const close = () => {
		if (closed) return;
		closed = true;
		socket.destroy();
	};
	socket.on("connect", () => {
		socket.write(`${JSON.stringify(request)}\n`);
	});
	socket.on("data", (chunk) => {
		buffer += chunk.toString("utf8");
		while (true) {
			const newline = buffer.indexOf("\n");
			if (newline === -1) break;
			const line = buffer.slice(0, newline).trimEnd();
			buffer = buffer.slice(newline + 1);
			if (line.length > 0) onLine(line);
		}
	});
	socket.on("error", (error) => {
		errored = true;
		if (!closed) onError(error);
	});
	socket.on("close", () => {
		const shouldNotify = !closed && !errored;
		closed = true;
		if (shouldNotify) onClose?.();
	});
	return { close };
}
