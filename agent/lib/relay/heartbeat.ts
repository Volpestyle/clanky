/**
 * Server-side dead-peer detection. A phone dropping off the tailnet closes
 * nothing: the TCP socket stays half-open and attach streams / poll loops keep
 * pumping base64 into it indefinitely. eve's WebSocketPeer exposes no ping API,
 * but on the Node adapter the underlying crossws peer surfaces the vendored
 * `ws` WebSocket (see peerBufferedBytes) whose protocol-level `ping()` every
 * RFC 6455 client answers automatically — no client change needed. Liveness is
 * any inbound message-hook call or a ws-level ping/pong from the peer. Where
 * the runtime exposes no ws-level ping, the relay sends an app-level
 * `{type:"ping", t}` frame instead and clients keep themselves alive with any
 * traffic (e.g. the `ping` op). Peers silent past the deadline are terminated
 * and fully cleaned up (attach streams, poll loops, pending commands).
 */
import type { WebSocketPeer } from "eve/channels";
import { relayLogError } from "./log.ts";
import { reply } from "./peers.ts";

const HEARTBEAT_INTERVAL_MS = 30_000;
const HEARTBEAT_TIMEOUT_MS = 90_000;

interface PeerWebSocketControl {
	ping?: (data?: unknown) => void;
	on?: (event: string, listener: (...args: unknown[]) => void) => unknown;
}

export interface PeerHeartbeatOptions {
	intervalMs?: number;
	timeoutMs?: number;
}

const peerLastSeenAt = new Map<WebSocketPeer, number>();
const peerHeartbeatTimers = new Map<WebSocketPeer, ReturnType<typeof setInterval>>();

/// Stamp inbound traffic from a peer. Only peers with a running heartbeat are
/// tracked, so a rejected (never-opened) peer cannot leak a map entry.
export function markPeerAlive(peer: WebSocketPeer): void {
	if (peerLastSeenAt.has(peer)) peerLastSeenAt.set(peer, Date.now());
}

export function startPeerHeartbeat(peer: WebSocketPeer, onDead: () => void, options: PeerHeartbeatOptions = {}): void {
	stopPeerHeartbeat(peer);
	const intervalMs = options.intervalMs ?? HEARTBEAT_INTERVAL_MS;
	const timeoutMs = options.timeoutMs ?? HEARTBEAT_TIMEOUT_MS;
	peerLastSeenAt.set(peer, Date.now());
	const socket = (peer as unknown as { websocket?: PeerWebSocketControl }).websocket;
	if (typeof socket?.on === "function") {
		// ws-level pings/pongs never reach the message hook; count them as liveness.
		socket.on("pong", () => markPeerAlive(peer));
		socket.on("ping", () => markPeerAlive(peer));
	}
	const timer = setInterval(() => {
		const lastSeen = peerLastSeenAt.get(peer) ?? 0;
		if (Date.now() - lastSeen > timeoutMs) {
			relayLogError(`peer ${peer.id} failed liveness check (${timeoutMs}ms without traffic); terminating`);
			onDead();
			return;
		}
		if (typeof socket?.ping === "function") {
			try {
				socket.ping();
			} catch (error) {
				relayLogError(`peer ${peer.id} ws ping failed`, error);
			}
		} else {
			reply(peer, { type: "ping", t: Date.now() });
		}
	}, intervalMs);
	timer.unref?.();
	peerHeartbeatTimers.set(peer, timer);
}

export function stopPeerHeartbeat(peer: WebSocketPeer): void {
	const timer = peerHeartbeatTimers.get(peer);
	if (timer !== undefined) clearInterval(timer);
	peerHeartbeatTimers.delete(peer);
	peerLastSeenAt.delete(peer);
}
