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
import { registerPushDevice, unregisterPushDevice } from "../lib/push-registry.ts";
import { ensurePushWatcher } from "../lib/push-watcher.ts";
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
		case "register-push": {
			// The phone registers its APNs device token after pairing so Clanky can
			// push when an agent goes blocked/done/error. Starts the watcher lazily.
			const token = str(args.token);
			if (!token) throw new Error("register-push requires token");
			const events = Array.isArray(args.events) ? (args.events as unknown[]).map(String) : [];
			const platform = str(args.platform) ?? "ios";
			await registerPushDevice({ token, platform, events });
			ensurePushWatcher();
			return { ok: true, registered: true };
		}
		case "unregister-push": {
			const token = str(args.token);
			if (!token) throw new Error("unregister-push requires token");
			await unregisterPushDevice(token);
			return { ok: true, unregistered: true };
		}
		case "write": {
			// Raw verbatim input — the keystroke path for the iOS live terminal
			// (SPEC.md §4.3). herdr's pane.send_text writes the bytes to the PTY
			// master unchanged, so typed text, control sequences (Ctrl-C as ),
			// and arrow-key escapes ([A) all pass through faithfully. Unlike
			// `run`/`send`, this appends NO trailing Enter — the client owns newlines.
			const pane = str(args.pane);
			const text = typeof args.text === "string" ? args.text : undefined;
			if (!pane || text === undefined) throw new Error("write requires pane and text");
			return herdrRequest("pane.send_text", { pane_id: pane, text });
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

// A peer may now hold several concurrent streams — one `events` subscription
// for swarm status plus one live `attach:<pane>` terminal stream per open pane —
// so streams are keyed rather than the old one-per-peer model.
interface StreamHandle {
	close(): void;
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

function registerStream(peer: WebSocketPeer, key: string, handle: StreamHandle): void {
	const map = streamsFor(peer);
	map.get(key)?.close();
	map.set(key, handle);
}

function closeStream(peer: WebSocketPeer, key?: string): void {
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

function subscribe(peer: WebSocketPeer, req: RelayRequest): void {
	const subscriptions = Array.isArray(req.args?.subscriptions) ? req.args.subscriptions : [];
	if (subscriptions.length === 0) throw new Error("subscribe requires subscriptions[]");
	const stream: HerdrStream = herdrStreamLines(
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
	registerStream(peer, "events", { close: () => stream.close() });
}

// Live terminal stream (SPEC.md §4.3, Phase 1). herdr exposes only bounded
// scrollback snapshots — no lossless follow stream — so the relay manufactures a
// live feed by re-reading the pane's visible screen (ANSI-preserving) and pushing
// a frame whenever the rendered content changes. The frame is a FULL snapshot
// (`full: true`); the client replaces its buffer rather than appending. Phase 2
// swaps this implementation for a herdr-native per-pane byte broadcast behind the
// same `attach` op + frame envelope, so the client never changes.
function attach(peer: WebSocketPeer, req: RelayRequest): void {
	const args = req.args ?? {};
	const pane = str(args.pane);
	if (!pane) throw new Error("attach requires pane");
	const source = str(args.source) ?? "visible";
	const format = str(args.format) ?? "ansi";
	const stripAnsi = args.strip_ansi === true;
	const lines = typeof args.lines === "number" ? args.lines : undefined;
	const intervalMs = Math.min(2000, Math.max(80, num(args.interval_ms, 180)));
	const key = `attach:${pane}`;

	let closed = false;
	let last: string | undefined;
	let timer: ReturnType<typeof setTimeout> | undefined;

	const tick = async (): Promise<void> => {
		if (closed) return;
		try {
			const params: Record<string, unknown> = { pane_id: pane, source, format, strip_ansi: stripAnsi };
			if (lines !== undefined) params.lines = lines;
			const result = await herdrRequest("pane.read", params);
			const read = (result as { read?: { text?: unknown } })?.read ?? result;
			const text = typeof (read as { text?: unknown })?.text === "string" ? (read as { text: string }).text : herdrText(result);
			if (!closed && text !== last) {
				last = text;
				reply(peer, {
					id: req.id,
					ok: true,
					stream: true,
					body: { type: "pane.output", pane_id: pane, source, format, full: true, text },
				});
			}
		} catch (error) {
			if (!closed) reply(peer, { id: req.id, ok: false, stream: true, error: (error as Error).message });
		}
		if (!closed) timer = setTimeout(() => void tick(), intervalMs);
	};

	registerStream(peer, key, {
		close: () => {
			closed = true;
			if (timer) clearTimeout(timer);
		},
	});
	void tick();
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
						closeStream(peer, pane ? `attach:${pane}` : undefined);
						reply(peer, { id: req.id, ok: true, detached: true });
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
