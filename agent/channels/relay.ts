/**
 * The eve relay channel — Clanky's single network window onto the herdr stage
 * (SPEC.md §4.4). A bearer-authenticated WebSocket that proxies herdr pane
 * operations to a remote client (the Clanky iOS app) over the tailnet, so
 * herdr stays vanilla (no fork) and the phone talks to one front door: eve.
 *
 * This relays herdr socket operations (the panes live on this host). It is a
 * raw proxy and does not start eve agent sessions.
 *
 * This file is the composition root; the implementation lives in
 * agent/lib/relay/* (protocol gate + parsing, peer registry, heartbeat,
 * command brokering, op dispatch, ordered input, terminal streaming).
 *
 * Env:
 *   CLANKY_RELAY_TOKEN   bearer token the client must present (?token= or
 *                        Authorization: Bearer). Fails closed when unset.
 */
import { defineChannel, GET, WS } from "eve/channels";
import type { WebSocketMessage, WebSocketPeer } from "eve/channels";
import { isFrontdoorAuthorized } from "../lib/frontdoor-auth.ts";
import { herdrRequest } from "../lib/herdr-socket.ts";
import { relayLogError, relayTrace } from "../lib/relay/log.ts";
import { int, parseRelayRequest, relayMessageText, str, type RelayRequest } from "../lib/relay/protocol.ts";
import {
	closeStream,
	commandPeers,
	commandPresence,
	facePeers,
	facePresence,
	liveTerminalStream,
	attachStreamKey,
	reply,
} from "../lib/relay/peers.ts";
import { markPeerAlive, startPeerHeartbeat, stopPeerHeartbeat } from "../lib/relay/heartbeat.ts";
import {
	closePendingCommandsFor,
	forwardCommandClientMessage,
	forwardCommandEvent,
	startCommand,
} from "../lib/relay/commands.ts";
import { dispatch } from "../lib/relay/ops.ts";
import { enqueueOrderedInput, orderedInputKey } from "../lib/relay/ordered-input.ts";
import { attach, subscribe } from "../lib/relay/attach.ts";

// Import-compatible re-exports for tests and tooling that target the channel
// module (test/relay-hardening-smoke.ts).
export { assertRelayInboundMessageSize, MAX_RELAY_INBOUND_MESSAGE_BYTES, parseRelayRequest } from "../lib/relay/protocol.ts";

function authorize(peer: WebSocketPeer): boolean {
	return isFrontdoorAuthorized(peer.request);
}

/// Full teardown for a departing peer — graceful close, socket error, or failed
/// liveness all funnel here: heartbeat, presence sets, pending commands (the
/// surviving counterparty gets notified), and every attach stream / poll loop.
/// Ordered-input queues are keyed by session|pane, shared across peers, and
/// self-expire as their promise chains drain, so they need no per-peer surgery.
function cleanupPeer(peer: WebSocketPeer): void {
	stopPeerHeartbeat(peer);
	facePeers.delete(peer);
	commandPeers.delete(peer);
	closePendingCommandsFor(peer);
	closeStream(peer);
}

export default defineChannel({
	routes: [
		GET("/relay/health", async (req) => {
			if (!isFrontdoorAuthorized(req)) return new Response("unauthorized", { status: 401 });
			try {
				const result = await herdrRequest("ping");
				return Response.json({ ok: true, herdr: result, face: facePresence(), commandHost: commandPresence() });
			} catch (error) {
				return Response.json({ ok: false, error: (error as Error).message }, { status: 502 });
			}
		}),
		WS("/relay/ws", async () => ({
			open(peer: WebSocketPeer) {
				if (!authorize(peer)) {
					peer.close(4401, "unauthorized");
					return;
				}
				startPeerHeartbeat(peer, () => {
					cleanupPeer(peer);
					peer.terminate();
				});
				reply(peer, { type: "ready" });
			},
			async message(peer: WebSocketPeer, message: WebSocketMessage) {
				if (!authorize(peer)) {
					peer.close(4401, "unauthorized");
					return;
				}
				markPeerAlive(peer);
				const tRx = Date.now();
				let req: RelayRequest;
				try {
					req = parseRelayRequest(relayMessageText(message));
				} catch (error) {
					relayLogError(`peer ${peer.id} sent a rejected frame`, error);
					reply(peer, { error: (error as Error).message });
					return;
				}
				try {
					if (req.op === "ping") {
						// App-level keepalive/RTT probe: replies from this process
						// with no herdr round trip.
						reply(peer, { id: req.id, ok: true, result: { t: Date.now() } });
						return;
					}
					if (req.op === "resize") {
						// Resize the server-owned terminal of a live Native attach
						// stream in place — no teardown/reattach (and no 50k-line
						// snapshot replay) on client geometry changes. Fails when the
						// peer holds no live attach stream for the pane; the client
						// treats that as "fall back to reattach".
						const pane = str(req.args?.pane);
						if (!pane) throw new Error("resize requires pane");
						const cols = int(req.args?.cols, 0);
						const rows = int(req.args?.rows, 0);
						if (cols <= 0 || rows <= 0) throw new Error("resize requires positive cols and rows");
						const stream = liveTerminalStream(peer, pane, str(req.args?.session));
						if (stream === undefined) throw new Error(`no live terminal attach stream for pane ${pane}; reattach to resize`);
						if (!stream.resize({ cols, rows })) throw new Error("herdr terminal attach stream rejected resize");
						reply(peer, { id: req.id, ok: true });
						return;
					}
					if (req.op === "subscribe") {
						subscribe(peer, req);
						return;
					}
					if (req.op === "unsubscribe") {
						closeStream(peer, "events");
						reply(peer, { id: req.id, ok: true, unsubscribed: true });
						return;
					}
					if (req.op === "attach") {
						attach(peer, req);
						return;
					}
					if (req.op === "detach") {
						const pane = str(req.args?.pane);
						closeStream(peer, pane ? attachStreamKey(str(req.args?.session), pane) : undefined);
						reply(peer, { id: req.id, ok: true, detached: true });
						return;
					}
					if (req.op === "face-attach") {
						facePeers.add(peer);
						reply(peer, { id: req.id, ok: true, face: "attached" });
						return;
					}
					if (req.op === "face-detach") {
						facePeers.delete(peer);
						if (!commandPeers.has(peer)) closePendingCommandsFor(peer);
						reply(peer, { id: req.id, ok: true, face: "detached" });
						return;
					}
					if (req.op === "command-attach") {
						commandPeers.add(peer);
						reply(peer, { id: req.id, ok: true, commandHost: "attached" });
						return;
					}
					if (req.op === "command-detach") {
						commandPeers.delete(peer);
						if (!facePeers.has(peer)) closePendingCommandsFor(peer);
						reply(peer, { id: req.id, ok: true, commandHost: "detached" });
						return;
					}
					if (req.op === "command" || req.op === "face-command") {
						startCommand(peer, req);
						return;
					}
					if (req.op === "command-event" || req.op === "face-command-event") {
						forwardCommandEvent(peer, req);
						return;
					}
					if (req.op === "command-client" || req.op === "face-command-client") {
						forwardCommandClientMessage(peer, req);
						return;
					}
					const inputKey = orderedInputKey(req);
					if (inputKey !== undefined) {
						enqueueOrderedInput(peer, req, inputKey, tRx);
						return;
					}
					const result = await dispatch(req.op, req.args ?? {});
					reply(peer, { id: req.id, ok: true, result });
				} catch (error) {
					relayTrace(`op ${req.op} failed: ${(error as Error).message}`);
					reply(peer, { id: req.id, ok: false, error: (error as Error).message });
				}
			},
			close(peer: WebSocketPeer) {
				cleanupPeer(peer);
			},
			error(peer: WebSocketPeer, error: Error) {
				relayLogError(`peer ${peer.id} websocket error`, error);
				cleanupPeer(peer);
			},
		})),
	],
});
