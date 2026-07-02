/**
 * Relay peer registry — per-peer stream handles (events subscription + live
 * terminal attaches), face / command-host presence sets, and the guarded
 * peer send path with observable failures.
 */
import type { WebSocketPeer } from "eve/channels";
import type { HerdrTerminalAttachStream } from "../herdr-client-socket.ts";
import { relayLogError } from "./log.ts";

// peer.send failures were previously swallowed, so a dead or wedged peer made
// the relay pump frames into the void with no signal anywhere. Log them,
// throttled per peer so a high-rate attach stream cannot flood the log between
// heartbeat sweeps.
const SEND_FAILURE_LOG_INTERVAL_MS = 5_000;
const peerSendFailures = new WeakMap<WebSocketPeer, { count: number; lastLogAt: number }>();

export function reply(peer: WebSocketPeer, body: Record<string, unknown>): void {
	try {
		peer.send(JSON.stringify(body));
	} catch (error) {
		const failures = peerSendFailures.get(peer) ?? { count: 0, lastLogAt: 0 };
		failures.count += 1;
		peerSendFailures.set(peer, failures);
		const now = Date.now();
		if (now - failures.lastLogAt >= SEND_FAILURE_LOG_INTERVAL_MS) {
			failures.lastLogAt = now;
			relayLogError(`peer ${peer.id} send failed (${failures.count} since connect)`, error);
		}
	}
}

// A peer may now hold several concurrent streams — one `events` subscription
// for swarm status plus one live `attach:<pane>` terminal stream per open pane —
// so streams are keyed rather than the old one-per-peer model.
export interface StreamHandle {
	close(): void;
	/// Present only on Native (`terminal_id`) attaches: resolves the live
	/// direct-attach terminal stream while it can carry input/resize, and
	/// undefined once the stream closed or fell back to snapshot polling.
	terminal?: () => HerdrTerminalAttachStream | undefined;
}

const peerStreams = new WeakMap<WebSocketPeer, Map<string, StreamHandle>>();

function streamsFor(peer: WebSocketPeer): Map<string, StreamHandle> {
	let map = peerStreams.get(peer);
	if (!map) {
		map = new Map();
		peerStreams.set(peer, map);
	}
	return map;
}

export function attachStreamKey(session: string | undefined, pane: string): string {
	return `attach:${session ?? ""}:${pane}`;
}

export function registerStream(peer: WebSocketPeer, key: string, handle: StreamHandle): void {
	const map = streamsFor(peer);
	map.get(key)?.close();
	map.set(key, handle);
}

export function closeStream(peer: WebSocketPeer, key?: string): void {
	const map = peerStreams.get(peer);
	if (!map) return;
	if (key === undefined) {
		for (const handle of map.values()) handle.close();
		map.clear();
		return;
	}
	const handle = map.get(key);
	if (handle) {
		handle.close();
		map.delete(key);
	}
}

export function liveTerminalStream(peer: WebSocketPeer, pane: string, session: string | undefined): HerdrTerminalAttachStream | undefined {
	return peerStreams.get(peer)?.get(attachStreamKey(session, pane))?.terminal?.();
}

/// eve passes crossws peers through to WS hooks; on the Node adapter the peer
/// exposes the underlying `ws` WebSocket (which carries bufferedAmount) via a
/// `websocket` getter that eve's WebSocketPeer type does not declare. Returns
/// 0 when the runtime does not expose it, which disables the guard rather
/// than dropping frames spuriously.
export function peerBufferedBytes(peer: WebSocketPeer): number {
	const socket = (peer as unknown as { websocket?: { bufferedAmount?: unknown } }).websocket;
	const buffered = socket?.bufferedAmount;
	return typeof buffered === "number" && Number.isFinite(buffered) ? buffered : 0;
}

// Live TUI faces attached via a `face-attach` op. Presence = connection alive;
// a face dropping (crash or quit) clears on the WS `close` hook. Surfaced in
// `/relay/health` as `face` so clients can show a visible UI vs headless mode.
export const facePeers = new Set<WebSocketPeer>();

// Command hosts are below the relay and own deterministic slash-command
// execution. A visible face may also be a command host, but iOS should depend on
// this capability, not on the visible TUI being open.
export const commandPeers = new Set<WebSocketPeer>();

export type PresenceRole = "face" | "command-host";

export interface PresencePeerDetail {
	readonly pid?: number;
	readonly role: PresenceRole;
	readonly connectedAt: string;
}

export interface PresenceSummary {
	readonly attached: boolean;
	readonly count: number;
	readonly peers: readonly PresencePeerDetail[];
}

const facePeerDetails = new WeakMap<WebSocketPeer, PresencePeerDetail>();
const commandPeerDetails = new WeakMap<WebSocketPeer, PresencePeerDetail>();

export function attachFacePeer(peer: WebSocketPeer, pid: number | undefined): PresencePeerDetail {
	const detail = presenceDetail("face", pid);
	facePeers.add(peer);
	facePeerDetails.set(peer, detail);
	return detail;
}

export function detachFacePeer(peer: WebSocketPeer): PresencePeerDetail | undefined {
	const detail = facePeerDetails.get(peer);
	facePeers.delete(peer);
	facePeerDetails.delete(peer);
	return detail;
}

export function attachCommandPeer(peer: WebSocketPeer, pid: number | undefined): PresencePeerDetail {
	const detail = presenceDetail("command-host", pid);
	commandPeers.add(peer);
	commandPeerDetails.set(peer, detail);
	return detail;
}

export function detachCommandPeer(peer: WebSocketPeer): PresencePeerDetail | undefined {
	const detail = commandPeerDetails.get(peer);
	commandPeers.delete(peer);
	commandPeerDetails.delete(peer);
	return detail;
}

export function detachPresencePeer(peer: WebSocketPeer): readonly PresencePeerDetail[] {
	const details = [detachFacePeer(peer), detachCommandPeer(peer)].filter((detail): detail is PresencePeerDetail => detail !== undefined);
	return details;
}

export function facePresence(): PresenceSummary {
	return presenceSummary(facePeers, facePeerDetails, "face");
}

export function commandPresence(): PresenceSummary {
	return presenceSummary(commandPeers, commandPeerDetails, "command-host");
}

export function attachedCommandPeer(): WebSocketPeer | undefined {
	for (const peer of commandPeers) {
		if (!facePeers.has(peer)) return peer;
	}
	return commandPeers.values().next().value;
}

function presenceDetail(role: PresenceRole, pid: number | undefined): PresencePeerDetail {
	return {
		...(pid === undefined ? {} : { pid }),
		role,
		connectedAt: new Date().toISOString(),
	};
}

function presenceSummary(peers: Set<WebSocketPeer>, details: WeakMap<WebSocketPeer, PresencePeerDetail>, role: PresenceRole): PresenceSummary {
	return {
		attached: peers.size > 0,
		count: peers.size,
		peers: [...peers].map((peer) => details.get(peer) ?? presenceDetail(role, undefined)),
	};
}
