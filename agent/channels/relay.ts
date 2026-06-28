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
import { resolveClankyFacePanePlacement, startHerdrAgentNearPlacement, type HerdrPanePlacement } from "../lib/herdr-placement.ts";
import { attachHerdrTerminal, type HerdrTerminalAttachStream } from "../lib/herdr-client-socket.ts";
import { herdrRequest, herdrStreamLines, type HerdrStream } from "../lib/herdr-socket.ts";
import { registerPushDevice, unregisterPushDevice } from "../lib/push-registry.ts";
import { ensurePushWatcher } from "../lib/push-watcher.ts";
import { apnsConfigured } from "../lib/apns.ts";
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

function int(v: unknown, fallback: number): number {
	return typeof v === "number" && Number.isFinite(v) ? Math.round(v) : fallback;
}

function rec(v: unknown): Record<string, unknown> {
	return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

const VANILLA_HERDR_FALLBACK_LINES = 1000;

function requestId(id: RelayRequest["id"]): string {
	return id === undefined ? `relay_${Date.now().toString(36)}` : String(id);
}

function isUnsupportedFullSourceError(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error);
	return (
		message.includes("unknown variant `full`") ||
		message.includes("unknown variant 'full'") ||
		message.includes("invalid read source: full")
	);
}

function annotateFullFallback(result: unknown, fallbackReason: string): unknown {
	const envelope = rec(result);
	const read = rec(envelope.read);
	if (Object.keys(read).length === 0) {
		return {
			source: "herdr-recent-unwrapped",
			fallback: true,
			fallbackReason,
			text: herdrText(result),
			herdr: result,
		};
	}
	return {
		...envelope,
		fallback: true,
		fallbackReason,
		requested_source: "full",
		read: {
			...read,
			source: "recent_unwrapped",
			truncated: true,
		},
	};
}

async function herdrReadWithFullFallback(
	method: "pane.read" | "agent.read",
	params: Record<string, unknown>,
): Promise<unknown> {
	try {
		return await herdrRequest(method, params);
	} catch (error) {
		if (params.source !== "full" || !isUnsupportedFullSourceError(error)) throw error;
		const fallbackParams = {
			...params,
			source: "recent_unwrapped",
			lines: VANILLA_HERDR_FALLBACK_LINES,
		};
		const fallback = await herdrRequest(method, fallbackParams);
		return annotateFullFallback(fallback, (error as Error).message);
	}
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
			const requestedLines = num(args.lines, 80);
			const herdrLines = source === "full" ? undefined : requestedLines;
			const format = str(args.format);
			if (!args.pane && source === "transcript") return readTranscript(target, { lines: requestedLines });
			if (!args.pane && source === "auto") {
				try {
					return await readTranscript(target, { lines: requestedLines });
				} catch (error) {
					const result = await herdrRequest("agent.read", { target, source: "recent_unwrapped", lines: requestedLines });
					return {
						source: "herdr-recent-unwrapped",
						fallback: true,
						fallbackReason: (error as Error).message,
						agent: target,
						lines: requestedLines,
						text: herdrText(result),
						herdr: result,
					};
				}
			}
			if (args.pane && source === "transcript") throw new Error("transcript reads require an agent name");
			if (args.pane && source === "auto") {
				const result = await herdrRequest("pane.read", { pane_id: target, source: "recent_unwrapped", lines: requestedLines });
				return {
					source: "herdr-recent-unwrapped",
					fallback: true,
					fallbackReason: "transcript reads require an agent name",
					pane: target,
					lines: requestedLines,
					text: herdrText(result),
					herdr: result,
				};
			}
			const params: Record<string, unknown> = args.pane ? { pane_id: target, source } : { target, source };
			if (herdrLines !== undefined) params.lines = herdrLines;
			if (format !== undefined) params.format = format;
			if (args.strip_ansi === true) params.strip_ansi = true;
			return args.pane
				? herdrReadWithFullFallback("pane.read", params)
				: herdrReadWithFullFallback("agent.read", params);
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
			const split = str(args.split);
			if (split !== undefined && split !== "right" && split !== "down") throw new Error("start split must be right or down");
			const explicitPlacement: HerdrPanePlacement = {
				...(str(args.workspace_id) === undefined ? {} : { workspace_id: str(args.workspace_id) }),
				...(str(args.tab_id) === undefined ? {} : { tab_id: str(args.tab_id) }),
				...(str(args.target_pane_id) === undefined ? {} : { target_pane_id: str(args.target_pane_id) }),
			};
			const hasExplicitPlacement = Object.keys(explicitPlacement).length > 0;
			return startHerdrAgentNearPlacement({
				name,
				argv: launchArgv,
				cwd,
				focus: args.focus === true,
				...(split === undefined ? {} : { split }),
				placement: hasExplicitPlacement ? explicitPlacement : await resolveClankyFacePanePlacement(),
			});
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
			return { ok: true, registered: true, apnsConfigured: apnsConfigured() };
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

// Live TUI faces attached via a `face-attach` op. Presence = connection alive;
// a face dropping (crash or quit) clears on the WS `close` hook. Surfaced in
// `/relay/health` as `face` so the iOS app can show headless vs face-attached.
const facePeers = new Set<WebSocketPeer>();

function facePresence(): { attached: boolean; count: number } {
	return { attached: facePeers.size > 0, count: facePeers.size };
}

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

interface PaneOutputFrame {
	type: "pane.output";
	pane_id: string;
	terminal_id?: string;
	source: string;
	format: string;
	full: boolean;
	text?: string;
	encoding?: "base64";
	data?: string;
	seq?: number;
	width?: number;
	height?: number;
	fallback?: boolean;
	fallbackReason?: string;
}

interface PaneSnapshot {
	text: string;
	source: string;
	fallback: boolean;
	fallbackReason?: string;
}

function errorMessageFromEnvelope(envelope: Record<string, unknown>): string | undefined {
	const error = rec(envelope.error);
	const message = str(error.message);
	const code = str(error.code);
	if (message) return message;
	if (code) return code;
	return undefined;
}

function paneAttachAccepted(envelope: Record<string, unknown>): boolean {
	const result = rec(envelope.result);
	return result.type === "pane_attached";
}

function paneAttachChunkFrame(envelope: Record<string, unknown>, pane: string): PaneOutputFrame | undefined {
	if (envelope.stream !== true) return undefined;
	const chunk = rec(envelope.chunk);
	if (chunk.encoding !== "base64") return undefined;
	const data = str(chunk.data);
	if (!data) return undefined;
	const chunkPane = str(chunk.pane_id) ?? pane;
	const seq = typeof chunk.seq === "number" && Number.isFinite(chunk.seq) ? chunk.seq : undefined;
	return {
		type: "pane.output",
		pane_id: chunkPane,
		source: "stream",
		format: "ansi",
		full: false,
		encoding: "base64",
		data,
		...(seq === undefined ? {} : { seq }),
	};
}

function snapshotText(result: unknown): string {
	const read = (result as { read?: { text?: unknown } })?.read ?? result;
	return typeof (read as { text?: unknown })?.text === "string" ? (read as { text: string }).text : herdrText(result);
}

async function readPaneSnapshot(
	pane: string,
	source: string,
	format: string,
	stripAnsi: boolean,
	lines: number | undefined,
): Promise<PaneSnapshot> {
	const params: Record<string, unknown> = { pane_id: pane, source, format, strip_ansi: stripAnsi };
	if (lines !== undefined) params.lines = lines;
	try {
		const result = await herdrRequest("pane.read", params);
		return { text: snapshotText(result), source, fallback: false };
	} catch (error) {
		if (source !== "full" || !isUnsupportedFullSourceError(error)) throw error;
		const fallbackSource = "recent_unwrapped";
		const fallbackParams: Record<string, unknown> = {
			pane_id: pane,
			source: fallbackSource,
			format,
			strip_ansi: stripAnsi,
			lines: lines ?? VANILLA_HERDR_FALLBACK_LINES,
		};
		const result = await herdrRequest("pane.read", fallbackParams);
		return {
			text: snapshotText(result),
			source: fallbackSource,
			fallback: true,
			fallbackReason: (error as Error).message,
		};
	}
}

// Live terminal stream (SPEC.md §4.4). Prefer Herdr's direct terminal client
// socket when the caller has a terminal_id; fall back to the older pane attach /
// snapshot-polling compatibility path behind the same relay op.
function attach(peer: WebSocketPeer, req: RelayRequest): void {
	const args = req.args ?? {};
	const pane = str(args.pane);
	if (!pane) throw new Error("attach requires pane");
	const source = str(args.source) ?? "visible";
	const format = str(args.format) ?? "ansi";
	const stripAnsi = args.strip_ansi === true;
	const lines = typeof args.lines === "number" ? args.lines : undefined;
	const intervalMs = Math.min(2000, Math.max(80, num(args.interval_ms, 180)));
	const terminalId = str(args.terminal_id);
	const key = `attach:${pane}`;

	let closed = false;
	let terminalStream: HerdrTerminalAttachStream | undefined;
	let nativeStream: HerdrStream | undefined;
	let last: string | undefined;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let nativeAcked = false;
	let snapshotReady = false;
	let fallbackStarted = false;
	let pendingChunks: PaneOutputFrame[] = [];

	const sendFrame = (body: PaneOutputFrame): void => {
		reply(peer, { id: req.id, ok: true, stream: true, body });
	};

	const startPolling = (fallbackReason: string): void => {
		if (closed || fallbackStarted) return;
		fallbackStarted = true;
		terminalStream?.close();
		terminalStream = undefined;
		nativeStream?.close();
		nativeStream = undefined;
		const tick = async (): Promise<void> => {
			if (closed) return;
			try {
				const snapshot = await readPaneSnapshot(pane, source, format, stripAnsi, lines);
				if (!closed && snapshot.text !== last) {
					last = snapshot.text;
					sendFrame({
						type: "pane.output",
						pane_id: pane,
						source: snapshot.source,
						format,
						full: true,
						text: snapshot.text,
						fallback: true,
						fallbackReason: snapshot.fallbackReason ?? fallbackReason,
					});
				}
			} catch (error) {
				if (!closed) reply(peer, { id: req.id, ok: false, stream: true, error: (error as Error).message });
			}
			if (!closed) timer = setTimeout(() => void tick(), intervalMs);
		};
		void tick();
	};

	const sendInitialSnapshot = async (): Promise<void> => {
		if (closed) return;
		try {
			const snapshot = await readPaneSnapshot(pane, source, format, stripAnsi, lines);
			if (closed) return;
			last = snapshot.text;
			sendFrame({
				type: "pane.output",
				pane_id: pane,
				source: snapshot.source,
				format,
				full: true,
				text: snapshot.text,
				...(snapshot.fallback ? { fallback: true, fallbackReason: snapshot.fallbackReason } : {}),
			});
			snapshotReady = true;
			for (const frame of pendingChunks) {
				if (closed) return;
				sendFrame(frame);
			}
			pendingChunks = [];
		} catch (error) {
			startPolling((error as Error).message);
		}
	};

	registerStream(peer, key, {
		close: () => {
			closed = true;
			terminalStream?.close();
			nativeStream?.close();
			if (timer) clearTimeout(timer);
		},
	});

	if (terminalId) {
		terminalStream = attachHerdrTerminal(
			{
				terminalId,
				takeover: args.takeover !== false,
				cols: int(args.cols, 80),
				rows: int(args.rows, 24),
				cellWidthPx: int(args.cell_width_px, 0),
				cellHeightPx: int(args.cell_height_px, 0),
			},
			{
				onFrame: (frame) => {
					if (closed || fallbackStarted) return;
					const body: PaneOutputFrame = {
						type: "pane.output",
						pane_id: pane,
						terminal_id: terminalId,
						source: "terminal_attach",
						format: "ansi",
						full: frame.full,
						encoding: "base64",
						data: frame.bytes.toString("base64"),
						seq: frame.seq,
						width: frame.width,
						height: frame.height,
					};
					if (!snapshotReady) {
						if (pendingChunks.length > 100) {
							startPolling("herdr terminal attach produced too many chunks before initial snapshot");
							return;
						}
						pendingChunks.push(body);
						return;
					}
					sendFrame(body);
				},
				onError: (error) => {
					if (!closed && !fallbackStarted) startPolling(error.message);
				},
				onClose: () => {
					if (!closed && !fallbackStarted) startPolling("herdr terminal attach stream closed");
				},
			},
		);
		void sendInitialSnapshot();
		return;
	}

	nativeStream = herdrStreamLines(
		{ id: requestId(req.id), method: "pane.attach", params: { pane_id: pane } },
		(line) => {
			if (closed || fallbackStarted) return;
			let envelope: Record<string, unknown>;
			try {
				envelope = rec(JSON.parse(line));
			} catch {
				startPolling("pane.attach returned invalid JSON");
				return;
			}

			if (!nativeAcked) {
				const error = errorMessageFromEnvelope(envelope);
				if (error) {
					startPolling(error);
					return;
				}
				if (paneAttachAccepted(envelope)) {
					nativeAcked = true;
					void sendInitialSnapshot();
					return;
				}
				startPolling("pane.attach returned an unexpected acknowledgement");
				return;
			}

			const frame = paneAttachChunkFrame(envelope, pane);
			if (!frame) return;
			if (!snapshotReady) {
				if (pendingChunks.length >= 2048) {
					startPolling("pane.attach produced too many chunks before initial snapshot");
					return;
				}
				pendingChunks.push(frame);
				return;
			}
			sendFrame(frame);
		},
		(error) => {
			if (!closed && !fallbackStarted) startPolling(error.message);
		},
		() => {
			if (!closed && !fallbackStarted) {
				const reason = nativeAcked ? "pane.attach stream closed" : "pane.attach closed before acknowledgement";
				startPolling(reason);
			}
		},
	);
}

export default defineChannel({
	routes: [
		GET("/relay/health", async (req) => {
			if (!isFrontdoorAuthorized(req)) return new Response("unauthorized", { status: 401 });
			try {
				const result = await herdrRequest("ping");
				return Response.json({ ok: true, herdr: result, face: facePresence() });
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
					if (req.op === "face-attach") {
						facePeers.add(peer);
						reply(peer, { id: req.id, ok: true, face: "attached" });
						return;
					}
					if (req.op === "face-detach") {
						facePeers.delete(peer);
						reply(peer, { id: req.id, ok: true, face: "detached" });
						return;
					}
					const result = await dispatch(req.op, req.args ?? {});
					reply(peer, { id: req.id, ok: true, result });
				} catch (error) {
					reply(peer, { id: req.id, ok: false, error: (error as Error).message });
				}
			},
			close(peer: WebSocketPeer) {
				facePeers.delete(peer);
				closeStream(peer);
			},
		})),
	],
});
