/**
 * Relay slash-command brokering — a client (iOS) asks the attached command
 * host (the Clanky face/TUI or a headless host) to run a native command; the
 * relay forwards menu events host→client and menu answers client→host, keyed
 * by command id, with an inactivity deadline on every pending command.
 */
import type { WebSocketPeer } from "eve/channels";
import { relayLogError } from "./log.ts";
import { attachedCommandPeer, commandPeers, reply } from "./peers.ts";
import { requestId, str, type RelayRequest } from "./protocol.ts";

export const COMMAND_TIMEOUT_MS = 60_000;

type PendingCommand = {
	readonly client: WebSocketPeer;
	readonly clientRequestId: RelayRequest["id"];
	readonly host: WebSocketPeer;
	readonly timeoutMs: number;
	timeout: ReturnType<typeof setTimeout> | undefined;
};

const pendingCommands = new Map<string, PendingCommand>();

/// (Re)arm a pending command's inactivity deadline. Interactive commands can
/// legitimately stream menu steps and wait on user picks well past any fixed
/// total-runtime budget, so the deadline measures silence, not duration: every
/// forwarded host event and client menu message re-arms it. On expiry both
/// sides are told — the client gets the standard error reply and the host gets
/// a `menu.cancel` so it does not keep an orphaned menu session open.
function armCommandTimeout(commandId: string, pending: PendingCommand): void {
	if (pending.timeout !== undefined) clearTimeout(pending.timeout);
	pending.timeout = setTimeout(() => {
		pendingCommands.delete(commandId);
		relayLogError(`command ${commandId} timed out after ${pending.timeoutMs}ms of inactivity`);
		reply(pending.host, {
			type: commandPeers.has(pending.host) ? "command.client" : "face.command.client",
			id: commandId,
			message: { type: "menu.cancel", sessionId: commandId },
		});
		reply(pending.client, {
			id: pending.clientRequestId,
			ok: false,
			error: "Clanky command host did not finish before the relay timeout.",
		});
	}, pending.timeoutMs);
}

export function startCommand(peer: WebSocketPeer, req: RelayRequest, timeoutMs: number = COMMAND_TIMEOUT_MS): void {
	const host = attachedCommandPeer();
	if (host === undefined) throw new Error("No Clanky command host is attached. Start Clanky before running native slash commands.");
	const commandLine = str(req.args?.command_line) ?? str(req.args?.commandLine);
	if (commandLine === undefined) throw new Error(`${req.op} requires command_line`);
	const commandId = requestId(req.id);
	const pending: PendingCommand = { client: peer, clientRequestId: req.id, host, timeoutMs, timeout: undefined };
	pendingCommands.set(commandId, pending);
	armCommandTimeout(commandId, pending);
	reply(host, { type: commandPeers.has(host) ? "command.request" : "face.command.request", id: commandId, commandLine });
}

export function forwardCommandEvent(peer: WebSocketPeer, req: RelayRequest): void {
	const commandId = str(req.args?.request_id) ?? str(req.args?.requestID) ?? requestId(req.id);
	const event = req.args?.event;
	const pending = pendingCommands.get(commandId);
	if (pending === undefined) return;
	if (pending.host !== peer) throw new Error(`${req.op} came from a different command host`);
	reply(pending.client, { id: pending.clientRequestId, ok: true, stream: true, body: event });
	if (isTerminalCommandEvent(event)) {
		if (pending.timeout !== undefined) clearTimeout(pending.timeout);
		pendingCommands.delete(commandId);
	} else {
		armCommandTimeout(commandId, pending);
	}
}

export function forwardCommandClientMessage(peer: WebSocketPeer, req: RelayRequest): void {
	const commandId = str(req.args?.request_id) ?? str(req.args?.requestID);
	const message = req.args?.message;
	if (commandId === undefined) throw new Error(`${req.op} requires request_id`);
	const pending = pendingCommands.get(commandId);
	if (pending === undefined) throw new Error("No pending command for request_id");
	if (pending.client !== peer) throw new Error(`${req.op} came from a different client peer`);
	armCommandTimeout(commandId, pending);
	reply(pending.host, { type: commandPeers.has(pending.host) ? "command.client" : "face.command.client", id: commandId, message });
	reply(peer, { id: req.id, ok: true, result: { sent: true } });
}

export function closePendingCommandsFor(peer: WebSocketPeer): void {
	for (const [commandId, pending] of pendingCommands) {
		if (pending.client !== peer && pending.host !== peer) continue;
		pendingCommands.delete(commandId);
		if (pending.timeout !== undefined) clearTimeout(pending.timeout);
		if (pending.client === peer) {
			reply(pending.host, {
				type: commandPeers.has(pending.host) ? "command.client" : "face.command.client",
				id: commandId,
				message: { type: "menu.cancel", sessionId: commandId },
			});
			continue;
		}
		if (pending.host === peer) {
			reply(pending.client, {
				id: pending.clientRequestId,
				ok: true,
				stream: true,
				body: {
					type: "menu.failed",
					sessionId: commandId,
					message: "The Clanky command host disconnected before the command finished.",
				},
			});
		}
	}
}

function isTerminalCommandEvent(event: unknown): boolean {
	if (event === null || typeof event !== "object" || Array.isArray(event)) return false;
	const type = (event as { type?: unknown }).type;
	return type === "menu.end" || type === "menu.failed";
}
