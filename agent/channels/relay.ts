/**
 * The eve relay channel — Clanky's single network window onto the herdr stage
 * (SPEC.md §4.4). A bearer-authenticated WebSocket that proxies herdr pane
 * operations to a remote client (the Clanky iOS app) over the tailnet, so
 * herdr stays vanilla (no fork) and the phone talks to one front door: eve.
 *
 * This relays herdr socket operations (the panes live on this host). It is a
 * raw proxy and does not start eve agent sessions.
 *
 * Env:
 *   CLANKY_RELAY_TOKEN   bearer token the client must present (?token= or
 *                        Authorization: Bearer). Fails closed when unset.
 */
import { defineChannel, GET, WS } from "eve/channels";
import type { WebSocketMessage, WebSocketPeer } from "eve/channels";
import { isFrontdoorAuthorized } from "../lib/frontdoor-auth.ts";
import { herdrRequest, herdrStreamLines, type HerdrStream } from "../lib/herdr-socket.ts";
import { newTranscriptRunId, readTranscript } from "../lib/transcripts.ts";
import { wrapTranscriptArgv } from "../tools/herdr_spawn.ts";

interface RelayRequest {
	id?: string | number;
	op: string;
	args?: Record<string, unknown>;
}

function str(v: unknown): string | undefined {
	return typeof v === "string" && v.length > 0 ? v : undefined;
}

function num(v: unknown, fallback: number): number {
	return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

function rec(v: unknown): Record<string, unknown> {
	return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function requestId(id: RelayRequest["id"]): string {
	return id === undefined ? `relay_${Date.now().toString(36)}` : String(id);
}

// Map a relay op to a herdr socket API request. Returns the decoded result.
async function dispatch(op: string, args: Record<string, unknown>): Promise<unknown> {
	const target = str(args.agent) ?? str(args.pane);
	switch (op) {
		case "api": {
			const method = str(args.method);
			if (!method) throw new Error("api requires method");
			return herdrRequest(method, rec(args.params));
		}
		case "health":
			return herdrRequest("ping");
		case "list":
			return herdrRequest("agent.list");
		case "workspaces":
			return herdrRequest("workspace.list");
		case "tabs":
			return herdrRequest("tab.list", args.workspace_id ? { workspace_id: args.workspace_id } : {});
		case "panes":
			return herdrRequest("pane.list", args.workspace_id ? { workspace_id: args.workspace_id } : {});
		case "get":
			if (!target) throw new Error("get requires agent or pane");
			return args.pane ? herdrRequest("pane.get", { pane_id: target }) : herdrRequest("agent.get", { target });
		case "read": {
			if (!target) throw new Error("read requires agent or pane");
			const source = str(args.source) ?? "auto";
			const lines = num(args.lines, 80);
			if (!args.pane && source === "transcript") return readTranscript(target, { lines });
			if (!args.pane && source === "auto") {
				try {
					return await readTranscript(target, { lines });
				} catch (error) {
					const result = await herdrRequest("agent.read", { target, source: "recent_unwrapped", lines });
					return {
						source: "herdr-recent-unwrapped",
						fallback: true,
						fallbackReason: (error as Error).message,
						agent: target,
						lines,
						text: herdrText(result),
						herdr: result,
					};
				}
			}
			if (args.pane && source === "transcript") throw new Error("transcript reads require an agent name");
			if (args.pane && source === "auto") {
				const result = await herdrRequest("pane.read", { pane_id: target, source: "recent_unwrapped", lines });
				return {
					source: "herdr-recent-unwrapped",
					fallback: true,
					fallbackReason: "transcript reads require an agent name",
					pane: target,
					lines,
					text: herdrText(result),
					herdr: result,
				};
			}
			return args.pane
				? herdrRequest("pane.read", { pane_id: target, source, lines })
				: herdrRequest("agent.read", { target, source, lines });
		}
		case "send": {
			const text = str(args.text);
			if (!target || text === undefined) throw new Error("send requires agent/pane and text");
			return args.pane
				? herdrRequest("pane.send_input", { pane_id: target, text, keys: ["Enter"] })
				: herdrRequest("agent.send", { target, text });
		}
		case "run": {
			const pane = str(args.pane);
			const text = str(args.text);
			if (!pane || text === undefined) throw new Error("run requires pane and text");
			return herdrRequest("pane.send_input", { pane_id: pane, text, keys: ["Enter"] });
		}
		case "keys": {
			const pane = str(args.pane);
			const keys = Array.isArray(args.keys) ? (args.keys as unknown[]).map(String) : [];
			if (!pane || keys.length === 0) throw new Error("keys requires pane and keys[]");
			return herdrRequest("pane.send_keys", { pane_id: pane, keys });
		}
		case "start": {
			const name = str(args.name);
			const argv = Array.isArray(args.argv) ? (args.argv as unknown[]).map(String) : [];
			if (!name || argv.length === 0) throw new Error("start requires name and argv[]");
			const cwd = str(args.cwd) ?? process.cwd();
			// Remote-spawned workers funnel through the same transcript seam as the
			// eve herdr_spawn tool and the operator spawn.sh, so a button in the iOS
			// app yields the same durable, session-pinned transcript as a model tool
			// call (SPEC.md §4.3). The raw `op:"api" method:"agent.start"` passthrough
			// stays the explicit escape hatch; this op never starts an unwrapped pane
			// unless the client opts out with transcript:false.
			const launchArgv =
				args.transcript === false ? argv : wrapTranscriptArgv({ agent: name, cwd, runId: newTranscriptRunId(), argv });
			const params: Record<string, unknown> = { name, argv: launchArgv, cwd, focus: args.focus === true };
			if (args.workspace_id) params.workspace_id = args.workspace_id;
			if (args.tab_id) params.tab_id = args.tab_id;
			const split = str(args.split);
			if (split) params.split = split;
			return herdrRequest("agent.start", params);
		}
		case "close": {
			const pane = str(args.pane);
			if (!pane) throw new Error("close requires pane");
			return herdrRequest("pane.close", { pane_id: pane });
		}
		default:
			throw new Error(`unknown op '${op}'`);
	}
}

function herdrText(result: unknown): string {
	if (typeof result === "string") return result;
	if (typeof result === "object" && result !== null && "text" in result) {
		const text = (result as { text?: unknown }).text;
		if (typeof text === "string") return text;
	}
	return JSON.stringify(result);
}

function authorize(peer: WebSocketPeer): boolean {
	return isFrontdoorAuthorized(peer.request);
}

function reply(peer: WebSocketPeer, body: Record<string, unknown>): void {
	peer.send(JSON.stringify(body));
}

const activeStreams = new WeakMap<WebSocketPeer, HerdrStream>();

function closeStream(peer: WebSocketPeer): void {
	activeStreams.get(peer)?.close();
	activeStreams.delete(peer);
}

function subscribe(peer: WebSocketPeer, req: RelayRequest): void {
	const subscriptions = Array.isArray(req.args?.subscriptions) ? req.args.subscriptions : [];
	if (subscriptions.length === 0) throw new Error("subscribe requires subscriptions[]");
	closeStream(peer);
	const stream = herdrStreamLines(
		{
			id: requestId(req.id),
			method: "events.subscribe",
			params: { subscriptions },
		},
		(line) => {
			let body: unknown = line;
			try {
				body = JSON.parse(line);
			} catch {}
			reply(peer, { id: req.id, ok: true, stream: true, body });
		},
		(error) => reply(peer, { id: req.id, ok: false, stream: true, error: error.message }),
	);
	activeStreams.set(peer, stream);
}

export default defineChannel({
	routes: [
		GET("/relay/health", async (req) => {
			if (!isFrontdoorAuthorized(req)) return new Response("unauthorized", { status: 401 });
			try {
				const result = await herdrRequest("ping");
				return Response.json({ ok: true, herdr: result });
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
				reply(peer, { type: "ready" });
			},
			async message(peer: WebSocketPeer, message: WebSocketMessage) {
				if (!authorize(peer)) {
					peer.close(4401, "unauthorized");
					return;
				}
				let req: RelayRequest;
				try {
					req = JSON.parse(message.text()) as RelayRequest;
				} catch {
					reply(peer, { error: "invalid JSON" });
					return;
				}
				try {
					if (req.op === "subscribe") {
						subscribe(peer, req);
						return;
					}
					if (req.op === "unsubscribe") {
						closeStream(peer);
						reply(peer, { id: req.id, ok: true, unsubscribed: true });
						return;
					}
					const result = await dispatch(req.op, req.args ?? {});
					reply(peer, { id: req.id, ok: true, result });
				} catch (error) {
					reply(peer, { id: req.id, ok: false, error: (error as Error).message });
				}
			},
			close(peer: WebSocketPeer) {
				closeStream(peer);
			},
		})),
	],
});
