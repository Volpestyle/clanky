/**
 * The eve relay channel — Clanky's single network window onto the herdr stage
 * (SPEC.md §4.4). A bearer-authenticated WebSocket that proxies herdr pane
 * operations to a remote client (the Clanky iOS app) over the tailnet, so
 * herdr stays vanilla (no fork) and the phone talks to one front door: eve.
 *
 * This relays herdr CLI operations (the panes live on this host). It is a raw
 * proxy and does not start eve agent sessions.
 *
 * Env:
 *   CLANKY_RELAY_TOKEN   bearer token the client must present (?token= or
 *                        Authorization: Bearer). Fails closed when unset.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { defineChannel, WS } from "eve/channels";
import type { WebSocketMessage, WebSocketPeer } from "eve/channels";

const run = promisify(execFile);

interface RelayRequest {
	id?: string | number;
	op: string;
	args?: Record<string, unknown>;
}

function str(v: unknown): string | undefined {
	return typeof v === "string" && v.length > 0 ? v : undefined;
}

async function herdr(args: string[]): Promise<string> {
	const { stdout } = await run("herdr", args, { encoding: "utf8" });
	return stdout.trim();
}

// Map a relay op to a herdr CLI invocation. Returns raw stdout (JSON or text).
async function dispatch(op: string, args: Record<string, unknown>): Promise<string> {
	const target = str(args.agent) ?? str(args.pane);
	switch (op) {
		case "list":
			return herdr(["agent", "list"]);
		case "workspaces":
			return herdr(["workspace", "list"]);
		case "get":
			if (!target) throw new Error("get requires agent or pane");
			return herdr(["agent", "get", target]);
		case "read": {
			if (!target) throw new Error("read requires agent or pane");
			const source = str(args.source) ?? "recent";
			const lines = String(typeof args.lines === "number" ? args.lines : 80);
			return herdr(["agent", "read", target, "--source", source, "--lines", lines]);
		}
		case "send": {
			const text = str(args.text);
			if (!target || text === undefined) throw new Error("send requires agent/pane and text");
			return herdr(["agent", "send", target, text]);
		}
		case "run": {
			const pane = str(args.pane);
			const text = str(args.text);
			if (!pane || text === undefined) throw new Error("run requires pane and text");
			return herdr(["pane", "run", pane, text]);
		}
		case "keys": {
			const pane = str(args.pane);
			const keys = Array.isArray(args.keys) ? (args.keys as unknown[]).map(String) : [];
			if (!pane || keys.length === 0) throw new Error("keys requires pane and keys[]");
			return herdr(["pane", "send-keys", pane, ...keys]);
		}
		default:
			throw new Error(`unknown op '${op}'`);
	}
}

function authorize(peer: WebSocketPeer): boolean {
	const expected = process.env.CLANKY_RELAY_TOKEN;
	if (!expected) return false; // fail closed when unconfigured
	let presented: string | null = null;
	try {
		presented = new URL(peer.request.url).searchParams.get("token");
	} catch {
		presented = null;
	}
	if (!presented) {
		const header = peer.request.headers.get("authorization");
		if (header?.startsWith("Bearer ")) presented = header.slice("Bearer ".length);
	}
	return presented === expected;
}

function reply(peer: WebSocketPeer, body: Record<string, unknown>): void {
	peer.send(JSON.stringify(body));
}

export default defineChannel({
	routes: [
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
					const result = await dispatch(req.op, req.args ?? {});
					reply(peer, { id: req.id, ok: true, result });
				} catch (error) {
					reply(peer, { id: req.id, ok: false, error: (error as Error).message });
				}
			},
		})),
	],
});
