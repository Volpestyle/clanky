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

type Getter = () => string;

interface FaceSocket {
	send(data: string): void;
	close(): void;
	addEventListener(type: "open" | "close" | "error", listener: () => void): void;
}

interface FacePresenceConfig {
	readonly host: Getter;
	readonly token: Getter;
	readonly pid: number;
}

const RECONNECT_MS = 2000;

let active = false;
let socket: FaceSocket | undefined;
let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
let config: FacePresenceConfig | undefined;

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

	const onGone = (): void => {
		if (socket === ws) socket = undefined;
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
