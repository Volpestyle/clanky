import type { WebSocketPeer } from "eve/channels";
import { herdrSocketPath } from "../agent/lib/herdr-socket.ts";
import {
	MAX_RELAY_INBOUND_MESSAGE_BYTES,
	assertRelayInboundMessageSize,
	parseRelayRequest,
} from "../agent/channels/relay.ts";
import { requestId } from "../agent/lib/relay/protocol.ts";
import { attachStreamKey, commandPeers } from "../agent/lib/relay/peers.ts";
import { orderedInputKey } from "../agent/lib/relay/ordered-input.ts";
import { forwardCommandEvent, startCommand } from "../agent/lib/relay/commands.ts";
import { startPeerHeartbeat, stopPeerHeartbeat, markPeerAlive } from "../agent/lib/relay/heartbeat.ts";

function check(label: string, ok: boolean): void {
	console.log(`${ok ? "ok  " : "FAIL"}  ${label}`);
	if (!ok) process.exitCode = 1;
}

function throws(label: string, fn: () => void, expected: string): void {
	try {
		fn();
		check(label, false);
	} catch (error) {
		check(label, error instanceof Error && error.message.includes(expected));
	}
}

assertRelayInboundMessageSize(MAX_RELAY_INBOUND_MESSAGE_BYTES);
throws(
	"relay rejects oversized inbound frames",
	() => assertRelayInboundMessageSize(MAX_RELAY_INBOUND_MESSAGE_BYTES + 1),
	"too large",
);

const parsed = parseRelayRequest(JSON.stringify({ id: 7, op: "list", args: { session: "clankies" } }));
check("relay parser keeps request id", parsed.id === 7);
check("relay parser keeps op", parsed.op === "list");
check("relay parser keeps object args", parsed.args?.session === "clankies");
throws("relay parser rejects missing op", () => parseRelayRequest(JSON.stringify({ id: 1 })), "invalid relay request");

check("named sessions resolve to herdr session socket", herdrSocketPath("clankies").endsWith("/sessions/clankies/herdr.sock"));
check("default session resolves to top-level socket", herdrSocketPath("default").endsWith("/.config/herdr/herdr.sock"));
throws("explicit socket paths are rejected", () => herdrSocketPath("/tmp/herdr.sock"), "session name");
throws("relative socket paths are rejected", () => herdrSocketPath("../herdr.sock"), "session name");

// --- fallback request ids never collide within a millisecond ----------------

const generatedIds = new Set<string>();
for (let i = 0; i < 1000; i++) generatedIds.add(requestId(undefined));
check("fallback request ids are collision-free", generatedIds.size === 1000);
check("explicit request ids pass through", requestId(42) === "42");

// --- attach-stream and ordered-input keys are session-scoped ----------------

check(
	"attach keys differ across sessions for the same pane",
	attachStreamKey("alpha", "pane-1") !== attachStreamKey("beta", "pane-1"),
);
// biome-ignore lint/suspicious/noSelfCompare: intentionally asserts the key function is deterministic across calls
check("attach keys are stable within a session", attachStreamKey("alpha", "pane-1") === attachStreamKey("alpha", "pane-1"));
check(
	"default-session attach key differs from a named session",
	attachStreamKey(undefined, "pane-1") !== attachStreamKey("alpha", "pane-1"),
);
check(
	"ordered-input keys differ across sessions for the same pane",
	orderedInputKey({ op: "write", args: { pane: "p1", text: "x", session: "alpha" } }) !==
		orderedInputKey({ op: "write", args: { pane: "p1", text: "x", session: "beta" } }),
);
check(
	"ordered-input keys match across input ops on the same pane+session",
	orderedInputKey({ op: "write", args: { pane: "p1", text: "x", session: "alpha" } }) ===
		orderedInputKey({ op: "keys", args: { pane: "p1", keys: ["Enter"], session: "alpha" } }),
);
check("non-input ops produce no ordered-input key", orderedInputKey({ op: "read", args: { pane: "p1" } }) === undefined);

// --- pending commands time out on inactivity and notify both sides ----------

interface FakePeer {
	peer: WebSocketPeer;
	sent: Record<string, unknown>[];
}

function fakePeer(): FakePeer {
	const sent: Record<string, unknown>[] = [];
	const peer = {
		id: `fake_${Math.random().toString(36).slice(2, 8)}`,
		send(data: unknown) {
			sent.push(JSON.parse(String(data)) as Record<string, unknown>);
		},
	} as unknown as WebSocketPeer;
	return { peer, sent };
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

{
	const host = fakePeer();
	const client = fakePeer();
	commandPeers.add(host.peer);
	try {
		throws(
			"command without command_line is rejected",
			() => startCommand(client.peer, { id: 1, op: "command", args: {} }, 30),
			"requires command_line",
		);

		// Timeout path: no host activity -> client gets the error reply, host a cancel.
		startCommand(client.peer, { id: 2, op: "command", args: { command_line: "/model" } }, 30);
		check("command host received the command request", host.sent.some((m) => m.type === "command.request"));
		await sleep(90);
		check(
			"stalled command replies ok:false to the client",
			client.sent.some((m) => m.id === 2 && m.ok === false && String(m.error).includes("timeout")),
		);
		check(
			"stalled command sends menu.cancel to the host",
			host.sent.some((m) => m.type === "command.client" && (m.message as { type?: string })?.type === "menu.cancel"),
		);

	} finally {
		commandPeers.delete(host.peer);
	}
}

{
	// Activity refresh + completion path: events re-arm the deadline; a terminal
	// event clears it so no timeout replies fire afterwards.
	const host2 = fakePeer();
	const client2 = fakePeer();
	commandPeers.add(host2.peer);
	try {
		startCommand(client2.peer, { id: 3, op: "command", args: { command_line: "/help" } }, 60);
		const request = host2.sent.find((m) => m.type === "command.request");
		const commandId = String(request?.id);
		await sleep(40);
		forwardCommandEvent(host2.peer, { op: "command-event", args: { request_id: commandId, event: { type: "menu.step" } } });
		await sleep(40); // past the original deadline; the event above re-armed it
		check(
			"host activity re-arms the inactivity deadline",
			!client2.sent.some((m) => m.ok === false),
		);
		forwardCommandEvent(host2.peer, { op: "command-event", args: { request_id: commandId, event: { type: "menu.end" } } });
		await sleep(90);
		check(
			"completed command never times out",
			!client2.sent.some((m) => m.ok === false) && client2.sent.filter((m) => m.stream === true).length === 2,
		);
	} finally {
		commandPeers.delete(host2.peer);
	}
}

// --- dead-peer heartbeat -----------------------------------------------------

{
	// Peer with a ws-level ping surface: pings flow, silence trips onDead.
	let pings = 0;
	let dead = false;
	const sent: unknown[] = [];
	const peer = {
		id: "hb_ws",
		send(data: unknown) {
			sent.push(data);
		},
		websocket: {
			ping() {
				pings += 1;
			},
			on() {},
		},
	} as unknown as WebSocketPeer;
	startPeerHeartbeat(peer, () => {
		dead = true;
		stopPeerHeartbeat(peer);
	}, { intervalMs: 10, timeoutMs: 25 });
	await sleep(20);
	check("heartbeat sends ws-level pings", pings > 0);
	check("live peer is not reaped early", !dead);
	await sleep(60);
	check("silent peer trips the liveness deadline", dead);

	// Traffic (markPeerAlive) keeps a peer alive indefinitely.
	let dead2 = false;
	const peer2 = {
		id: "hb_alive",
		send() {},
		websocket: { ping() {}, on() {} },
	} as unknown as WebSocketPeer;
	startPeerHeartbeat(peer2, () => {
		dead2 = true;
	}, { intervalMs: 10, timeoutMs: 25 });
	for (let i = 0; i < 8; i++) {
		await sleep(10);
		markPeerAlive(peer2);
	}
	check("active peer survives past the deadline window", !dead2);
	stopPeerHeartbeat(peer2);

	// Runtime without ws-level ping: app-level {type:"ping"} frames are sent.
	let dead3 = false;
	const appSent: Record<string, unknown>[] = [];
	const peer3 = {
		id: "hb_app",
		send(data: unknown) {
			appSent.push(JSON.parse(String(data)) as Record<string, unknown>);
		},
	} as unknown as WebSocketPeer;
	startPeerHeartbeat(peer3, () => {
		dead3 = true;
		stopPeerHeartbeat(peer3);
	}, { intervalMs: 10, timeoutMs: 25 });
	await sleep(20);
	check("app-level ping frames are sent when ws ping is unavailable", appSent.some((m) => m.type === "ping"));
	await sleep(60);
	check("app-level-ping peer is reaped when silent", dead3);
}

if (process.exitCode === undefined) console.log("relay hardening smoke OK");
