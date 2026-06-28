/**
 * Face presence — lets the brain (the eve server) know a TUI face is attached.
 *
 * The eve `Client` the face uses is request/response HTTP, so the server can't
 * observe it. Instead the face holds a dedicated WebSocket to the brain's relay
 * (`/relay/ws`) and sends a `face-attach` op; the relay tracks the live peer and
 * reports `face.attached` in `/relay/health`. Presence = connection alive, so a
 * crashed face clears automatically when its socket closes. The iOS app reads
 * this to show "headless vs face-attached". See
 * clanky-ios/docs/native-menu-mirroring.md and the brain-topology notes.
 *
 * Best-effort and self-healing: it reconnects across brain restarts and no-ops
 * when the socket cannot be opened. Host/token are getters so it always uses the
 * current brain (which can change between owned and external servers).
 */

import { WebSocket } from "ws";
import type { ClankyMenuClientMessage, ClankyMenuServerEvent } from "./clanky-menu-protocol.ts";

type Getter = () => string;

interface FaceSocket {
	send(data: string): void;
	close(): void;
	addEventListener(type: "open" | "close" | "error", listener: () => void): void;
	addEventListener(type: "message", listener: (event: { readonly data: unknown }) => void): void;
}

interface FacePresenceConfig {
	readonly host: Getter;
	readonly token: Getter;
	readonly pid: number;
	readonly onCommandRequest?: (request: FaceCommandRequest) => Promise<void> | void;
}

const RECONNECT_MS = 2000;

let active = false;
let socket: FaceSocket | undefined;
let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
let config: FacePresenceConfig | undefined;
const commandWaiters = new Map<string, (message: ClankyMenuClientMessage | undefined) => void>();

export interface FaceCommandRequest {
	readonly id: string;
	readonly commandLine: string;
	send(event: ClankyMenuServerEvent): void;
	waitForClientMessage(): Promise<ClankyMenuClientMessage | undefined>;
}

export function startFacePresence(next: FacePresenceConfig): void {
	config = next;
	if (active) return; // idempotent — the existing loop covers brain restarts
	active = true;
	connect();
}

export function stopFacePresence(): void {
	active = false;
	if (reconnectTimer !== undefined) {
		clearTimeout(reconnectTimer);
		reconnectTimer = undefined;
	}
	try {
		socket?.close();
	} catch {
		// ignore
	}
	socket = undefined;
}

function connect(): void {
	if (!active || config === undefined) return;

	const token = config.token();
	if (token.trim().length === 0) {
		scheduleReconnect(); // token not available yet; try again shortly
		return;
	}

	const base = config.host().replace(/^http/u, "ws");
	const url = `${base}/relay/ws`;

	let ws: FaceSocket;
	try {
		ws = new WebSocket(url, { headers: { Authorization: `Bearer ${token}` } });
	} catch {
		scheduleReconnect();
		return;
	}
	socket = ws;

	const pid = config.pid;
	ws.addEventListener("open", () => {
		try {
			ws.send(JSON.stringify({ op: "face-attach", args: { pid } }));
		} catch {
			// ignore — close handler will reconnect
		}
	});
	ws.addEventListener("message", (event) => {
		handleRelayMessage(ws, event.data);
	});

	const onGone = (): void => {
		if (socket === ws) socket = undefined;
		resolveAllCommandWaiters(undefined);
		scheduleReconnect();
	};
	ws.addEventListener("close", onGone);
	ws.addEventListener("error", () => {
		try {
			ws.close();
		} catch {
			onGone();
		}
	});
}

function scheduleReconnect(): void {
	if (!active) return;
	if (reconnectTimer !== undefined) clearTimeout(reconnectTimer);
	reconnectTimer = setTimeout(connect, RECONNECT_MS);
}

function handleRelayMessage(ws: FaceSocket, data: unknown): void {
	const payload = parseRelayPayload(data);
	if (payload === undefined) return;
	if (payload.type === "face.command.request") {
		const id = typeof payload.id === "string" || typeof payload.id === "number" ? String(payload.id) : "";
		const commandLine = typeof payload.commandLine === "string" ? payload.commandLine : "";
		if (id.length === 0 || commandLine.trim().length === 0) return;
		const onCommandRequest = config?.onCommandRequest;
		if (onCommandRequest === undefined) {
			sendFaceCommandEvent(ws, id, {
				type: "menu.failed",
				sessionId: id,
				message: "This Clanky face does not support native command mirroring.",
			});
			return;
		}
		void Promise.resolve(onCommandRequest({
			id,
			commandLine,
			send(event) {
				sendFaceCommandEvent(ws, id, event);
			},
			waitForClientMessage() {
				return waitForClientMessage(id);
			},
		})).catch((error: unknown) => {
			sendFaceCommandEvent(ws, id, {
				type: "menu.failed",
				sessionId: id,
				message: error instanceof Error ? error.message : String(error),
			});
		});
		return;
	}
	if (payload.type === "face.command.client") {
		const id = typeof payload.id === "string" || typeof payload.id === "number" ? String(payload.id) : "";
		if (id.length === 0) return;
		const message = isClankyMenuClientMessage(payload.message) ? payload.message : undefined;
		resolveCommandWaiter(id, message);
	}
}

function sendFaceCommandEvent(ws: FaceSocket, requestId: string, event: ClankyMenuServerEvent): void {
	ws.send(JSON.stringify({ op: "face-command-event", args: { request_id: requestId, event } }));
}

function waitForClientMessage(requestId: string): Promise<ClankyMenuClientMessage | undefined> {
	return new Promise((resolve) => {
		commandWaiters.set(requestId, resolve);
	});
}

function resolveCommandWaiter(requestId: string, message: ClankyMenuClientMessage | undefined): void {
	const resolve = commandWaiters.get(requestId);
	if (resolve === undefined) return;
	commandWaiters.delete(requestId);
	resolve(message);
}

function resolveAllCommandWaiters(message: ClankyMenuClientMessage | undefined): void {
	for (const [requestId, resolve] of commandWaiters) {
		commandWaiters.delete(requestId);
		resolve(message);
	}
}

function parseRelayPayload(data: unknown): Record<string, unknown> | undefined {
	const text = payloadText(data);
	if (text === undefined) return undefined;
	try {
		const parsed = JSON.parse(text) as unknown;
		return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : undefined;
	} catch {
		return undefined;
	}
}

function payloadText(data: unknown): string | undefined {
	if (typeof data === "string") return data;
	if (Buffer.isBuffer(data)) return data.toString("utf8");
	if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
	if (Array.isArray(data)) return Buffer.concat(data.map((part) => Buffer.from(part))).toString("utf8");
	return undefined;
}

function isClankyMenuClientMessage(value: unknown): value is ClankyMenuClientMessage {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
	const object = value as Record<string, unknown>;
	const type = object.type;
	if (type === "menu.cancel") return typeof object.sessionId === "string";
	if (type !== "menu.respond" && type !== "menu.back") return false;
	return typeof object.sessionId === "string" && typeof object.stepId === "string";
}
