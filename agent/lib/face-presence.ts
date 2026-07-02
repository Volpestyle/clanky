/**
 * Face / command-host presence — lets the brain (the eve server) know which
 * companion process is attached.
 *
 * The eve `Client` the face uses is request/response HTTP, so the server can't
 * observe it. Instead a face or headless command host holds a dedicated
 * WebSocket to the brain's relay (`/relay/ws`) and sends `face-attach`,
 * `command-attach`, or both. The relay reports `face` and `commandHost` in
 * `/relay/health`. Presence = connection alive, so a crashed companion clears
 * automatically when its socket closes. The remote menu mirror lives in
 * clanky-ios/apps/mobile/src/net/command.ts and
 * clanky-ios/apps/mobile/src/menus/.
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
	readonly role?: "face" | "command-host" | "face-command-host";
	readonly onCommandRequest?: (request: FaceCommandRequest) => Promise<void> | void;
	readonly onStateChange?: (state: FacePresenceState) => void;
}

const RECONNECT_MS = 2000;
const ATTACH_ACK_TIMEOUT_MS = 10_000;
const FAILURE_ESCALATION_INTERVAL = 30;

let active = false;
let socket: FaceSocket | undefined;
let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
let attachAckTimer: ReturnType<typeof setTimeout> | undefined;
let config: FacePresenceConfig | undefined;
const commandWaiters = new Map<string, (message: ClankyMenuClientMessage | undefined) => void>();
let attachSequence = 0;
let consecutiveFailures = 0;
let pendingAttachAcks = new Map<string, string>();
let ackedAttachOps = new Set<string>();
const socketFailureReasons = new WeakMap<FaceSocket, string>();
let presence: FacePresenceState = { state: "stopped", since: Date.now(), acked: false };

export interface FaceCommandRequest {
	readonly id: string;
	readonly commandLine: string;
	send(event: ClankyMenuServerEvent): void;
	waitForClientMessage(): Promise<ClankyMenuClientMessage | undefined>;
}

export type FacePresenceStatus = "stopped" | "connecting" | "attached" | "detached";

export interface FacePresenceState {
	readonly state: FacePresenceStatus;
	readonly since: number;
	readonly lastError?: string;
	readonly acked: boolean;
}

export function startFacePresence(next: FacePresenceConfig): void {
	config = next;
	if (active) return; // idempotent — the existing loop covers brain restarts
	active = true;
	setPresenceState("connecting", { acked: false });
	connect();
}

export function stopFacePresence(): void {
	active = false;
	if (reconnectTimer !== undefined) {
		clearTimeout(reconnectTimer);
		reconnectTimer = undefined;
	}
	clearAttachAckTimer();
	try {
		socket?.close();
	} catch {
		// ignore
	}
	socket = undefined;
	pendingAttachAcks = new Map();
	ackedAttachOps = new Set();
	consecutiveFailures = 0;
	setPresenceState("stopped", { acked: false, log: false });
}

export function facePresenceState(): FacePresenceState {
	return { ...presence };
}

function connect(): void {
	if (!active || config === undefined) return;
	reconnectTimer = undefined;

	const retryingFromDetached = presence.state === "detached" && consecutiveFailures > 0;
	if (!retryingFromDetached) setPresenceState("connecting", { acked: false });

	try {
		const token = config.token();
		if (token.trim().length === 0) throw new Error("relay token is not configured");

		const base = config.host().replace(/^http/u, "ws");
		const url = `${base}/relay/ws`;
		const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${token}` } }) as FaceSocket;
		socket = ws;
		wireSocket(ws);
	} catch (error) {
		recordConnectionFailure(error);
		scheduleReconnect();
	}
}

function wireSocket(ws: FaceSocket): void {
	let gone = false;
	let lastSocketError: string | undefined;
	const pid = config?.pid ?? process.pid;
	ws.addEventListener("open", () => {
		try {
			const expectedOps = attachOps(config?.role);
			pendingAttachAcks = new Map();
			ackedAttachOps = new Set();
			for (const op of attachOps(config?.role)) {
				const id = nextAttachId(op);
				pendingAttachAcks.set(id, op);
				ws.send(JSON.stringify({ id, op, args: { pid } }));
			}
			scheduleAttachAckTimeout(ws, expectedOps);
		} catch (error) {
			failSocket(ws, formatErrorMessage(error));
		}
	});
	ws.addEventListener("message", (event) => {
		handleRelayMessage(ws, event.data);
	});

	const onGone = (event?: { readonly code?: number; readonly reason?: unknown }): void => {
		if (gone) return;
		gone = true;
		clearAttachAckTimer();
		if (socket === ws) socket = undefined;
		pendingAttachAcks = new Map();
		ackedAttachOps = new Set();
		resolveAllCommandWaiters(undefined);
		if (!active) return;
		recordConnectionFailure(closeFailureMessage(event, socketFailureReasons.get(ws) ?? lastSocketError));
		scheduleReconnect();
	};
	ws.addEventListener("close", onGone as () => void);
	ws.addEventListener("error", (event?: { readonly error?: unknown; readonly message?: string }) => {
		lastSocketError = socketErrorMessage(event);
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

function scheduleAttachAckTimeout(ws: FaceSocket, expectedOps: readonly string[]): void {
	clearAttachAckTimer();
	attachAckTimer = setTimeout(() => {
		if (!active || socket !== ws || expectedOps.every((op) => ackedAttachOps.has(op))) return;
		const missing = expectedOps.filter((op) => !ackedAttachOps.has(op)).join(", ");
		failSocket(ws, `attach acknowledgement timeout (${missing})`);
	}, ATTACH_ACK_TIMEOUT_MS);
	attachAckTimer.unref?.();
}

function clearAttachAckTimer(): void {
	if (attachAckTimer !== undefined) clearTimeout(attachAckTimer);
	attachAckTimer = undefined;
}

function attachOps(role: FacePresenceConfig["role"]): readonly string[] {
	switch (role ?? "face-command-host") {
		case "face":
			return ["face-attach"];
		case "command-host":
			return ["command-attach"];
		case "face-command-host":
			return ["face-attach", "command-attach"];
	}
}

function handleRelayMessage(ws: FaceSocket, data: unknown): void {
	const payload = parseRelayPayload(data);
	if (payload === undefined) return;
	if (handleAttachAck(ws, payload)) return;
	if (!presence.acked && typeof payload.error === "string") {
		failSocket(ws, payload.error);
		return;
	}
	if (payload.type === "command.request" || payload.type === "face.command.request") {
		const id = typeof payload.id === "string" || typeof payload.id === "number" ? String(payload.id) : "";
		const commandLine = typeof payload.commandLine === "string" ? payload.commandLine : "";
		if (id.length === 0 || commandLine.trim().length === 0) return;
		const onCommandRequest = config?.onCommandRequest;
		if (onCommandRequest === undefined) {
			sendCommandEvent(ws, id, {
				type: "menu.failed",
				sessionId: id,
				message: "This Clanky process does not support native command execution.",
			});
			return;
		}
		void Promise.resolve(onCommandRequest({
			id,
			commandLine,
			send(event) {
				sendCommandEvent(ws, id, event);
			},
			waitForClientMessage() {
				return waitForClientMessage(id);
			},
		})).catch((error: unknown) => {
			sendCommandEvent(ws, id, {
				type: "menu.failed",
				sessionId: id,
				message: error instanceof Error ? error.message : String(error),
			});
		});
		return;
	}
	if (payload.type === "command.client" || payload.type === "face.command.client") {
		const id = typeof payload.id === "string" || typeof payload.id === "number" ? String(payload.id) : "";
		if (id.length === 0) return;
		const message = isClankyMenuClientMessage(payload.message) ? payload.message : undefined;
		resolveCommandWaiter(id, message);
	}
}

function handleAttachAck(ws: FaceSocket, payload: Record<string, unknown>): boolean {
	const id = typeof payload.id === "string" || typeof payload.id === "number" ? String(payload.id) : undefined;
	if (id === undefined) return false;
	const op = pendingAttachAcks.get(id);
	if (op === undefined) return false;
	pendingAttachAcks.delete(id);
	if (payload.ok !== true) {
		failSocket(ws, typeof payload.error === "string" ? payload.error : `${op} was rejected`);
		return true;
	}
	ackedAttachOps.add(op);
	if (attachOps(config?.role).every((expected) => ackedAttachOps.has(expected))) {
		clearAttachAckTimer();
		consecutiveFailures = 0;
		setPresenceState("attached", { acked: true, lastError: undefined });
	}
	return true;
}

function failSocket(ws: FaceSocket, reason: string): void {
	socketFailureReasons.set(ws, reason);
	try {
		ws.close();
	} catch {
		if (socket === ws) socket = undefined;
		resolveAllCommandWaiters(undefined);
		recordConnectionFailure(reason);
		scheduleReconnect();
	}
}

function nextAttachId(op: string): string {
	attachSequence += 1;
	return `presence_${process.pid}_${attachSequence}_${op}`;
}

function recordConnectionFailure(error: unknown): void {
	consecutiveFailures += 1;
	const message = formatErrorMessage(error);
	setPresenceState("detached", { acked: false, lastError: message });
	if (consecutiveFailures % FAILURE_ESCALATION_INTERVAL === 0) {
		console.error(`clanky presence: still detached after ${consecutiveFailures} failures; last error: ${message}`);
	}
}

function setPresenceState(
	state: FacePresenceStatus,
	options: { readonly acked: boolean; readonly lastError?: string; readonly log?: boolean },
): void {
	const previous = presence;
	const changed =
		previous.state !== state ||
		previous.acked !== options.acked ||
		previous.lastError !== options.lastError;
	presence = {
		state,
		since: previous.state === state ? previous.since : Date.now(),
		acked: options.acked,
		...(options.lastError === undefined ? {} : { lastError: options.lastError }),
	};
	if (!changed) return;
	if (options.log !== false && previous.state !== state) {
		const detail = options.lastError === undefined ? "" : ` (${options.lastError})`;
		console.error(`clanky presence: ${state}${detail}`);
	}
	config?.onStateChange?.(facePresenceState());
}

function closeFailureMessage(event: { readonly code?: number; readonly reason?: unknown } | undefined, fallback: string | undefined): string {
	const code = event?.code;
	const reason = closeReasonText(event?.reason);
	const parts = [
		code === undefined ? undefined : `close ${code}`,
		reason === undefined || reason.length === 0 ? undefined : reason,
		fallback,
	].filter((part): part is string => part !== undefined && part.length > 0);
	return parts.length === 0 ? "socket closed before relay attach acknowledgement" : parts.join(": ");
}

function socketErrorMessage(event: { readonly error?: unknown; readonly message?: string } | undefined): string {
	if (event?.error !== undefined) return formatErrorMessage(event.error);
	if (event?.message !== undefined) return event.message;
	return "websocket error";
}

function closeReasonText(reason: unknown): string | undefined {
	if (reason === undefined || reason === null) return undefined;
	if (typeof reason === "string") return reason;
	if (Buffer.isBuffer(reason)) return reason.toString("utf8");
	return String(reason);
}

function formatErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function sendCommandEvent(ws: FaceSocket, requestId: string, event: ClankyMenuServerEvent): void {
	ws.send(JSON.stringify({ op: "command-event", args: { request_id: requestId, event } }));
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
