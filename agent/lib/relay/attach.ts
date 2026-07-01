/**
 * Relay terminal streaming — the held-open `attach` stream (Native terminal
 * attach with snapshot seeding, pane.attach chunks, and the snapshot-polling
 * compatibility fallback), server-side WS backpressure for live output, and
 * the herdr `events.subscribe` relay.
 */
import type { WebSocketPeer } from "eve/channels";
import { attachHerdrTerminal, type HerdrTerminalAttachStream } from "../herdr-client-socket.ts";
import { herdrRequest, herdrStreamLines, type HerdrStream } from "../herdr-socket.ts";
import { relayLogError, relayTrace } from "./log.ts";
import { attachStreamKey, peerBufferedBytes, registerStream, reply } from "./peers.ts";
import { int, num, rec, requestId, str, type RelayRequest } from "./protocol.ts";
import { herdrText, isUnsupportedFullSourceError, VANILLA_HERDR_FALLBACK_LINES } from "./ops.ts";

// Server-side WS backpressure guard for terminal output. A slow or
// backgrounded client stops draining its socket; without a cap the relay
// buffers unbounded output frames in-process. Above the drop threshold,
// live output frames for that attach stream are discarded and the stream is
// marked needs-resync; once the socket drains below the resync threshold the
// client gets a fresh full snapshot (through the existing pendingChunks
// replay seam) instead of the dropped bytes. Initial snapshots and their
// replays are exempt — only live delta frames are droppable.
const BACKPRESSURE_DROP_BYTES = 4 * 1024 * 1024;
const BACKPRESSURE_RESYNC_BYTES = 512 * 1024;

export function subscribe(peer: WebSocketPeer, req: RelayRequest): void {
	const subscriptions = Array.isArray(req.args?.subscriptions) ? req.args.subscriptions : [];
	if (subscriptions.length === 0) throw new Error("subscribe requires subscriptions[]");
	const session = str(req.args?.session);
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
		(error) => {
			relayLogError("events subscription stream failed", error);
			reply(peer, { id: req.id, ok: false, stream: true, error: error.message });
		},
		undefined,
		session,
	);
	registerStream(peer, "events", { close: () => stream.close() });
}

export interface PaneOutputFrame {
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
	/// Server send time (Date.now()) — additive latency-instrumentation field;
	/// clients that parse frames strictly strip unknown keys.
	t_frame?: number;
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
	session?: string,
): Promise<PaneSnapshot> {
	const params: Record<string, unknown> = { pane_id: pane, source, format, strip_ansi: stripAnsi };
	if (lines !== undefined) params.lines = lines;
	try {
		const result = await herdrRequest("pane.read", params, session);
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
		const result = await herdrRequest("pane.read", fallbackParams, session);
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
export function attach(peer: WebSocketPeer, req: RelayRequest): void {
	const args = req.args ?? {};
	const pane = str(args.pane);
	if (!pane) throw new Error("attach requires pane");
	const source = str(args.source) ?? "visible";
	const format = str(args.format) ?? "ansi";
	const stripAnsi = args.strip_ansi === true;
	const lines = typeof args.lines === "number" ? args.lines : undefined;
	const intervalMs = Math.min(2000, Math.max(80, num(args.interval_ms, 180)));
	const terminalId = str(args.terminal_id);
	const session = str(args.session);
	const key = attachStreamKey(session, pane);

	let closed = false;
	let terminalStream: HerdrTerminalAttachStream | undefined;
	let nativeStream: HerdrStream | undefined;
	let last: string | undefined;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let nativeAcked = false;
	let snapshotReady = false;
	let fallbackStarted = false;
	let needsResync = false;
	let pendingChunks: PaneOutputFrame[] = [];

	const sendFrame = (body: PaneOutputFrame): void => {
		reply(peer, { id: req.id, ok: true, stream: true, body: { ...body, t_frame: Date.now() } });
	};

	const startPolling = (fallbackReason: string): void => {
		if (closed || fallbackStarted) return;
		fallbackStarted = true;
		relayLogError(`attach pane=${pane} fell back to snapshot polling`, fallbackReason);
		terminalStream?.close();
		terminalStream = undefined;
		nativeStream?.close();
		nativeStream = undefined;
		const tick = async (): Promise<void> => {
			if (closed) return;
			try {
				const snapshot = await readPaneSnapshot(pane, source, format, stripAnsi, lines, session);
				if (!closed && snapshot.text !== last) {
					// Backpressure: skip this full-text frame for a non-draining
					// client and leave `last` stale so the next healthy tick
					// resends the complete snapshot — no resync bookkeeping needed.
					if (peerBufferedBytes(peer) <= BACKPRESSURE_DROP_BYTES) {
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
				}
			} catch (error) {
				relayTrace(`attach pane=${pane} poll read failed: ${(error as Error).message}`);
				if (!closed) reply(peer, { id: req.id, ok: false, stream: true, error: (error as Error).message });
			}
			if (!closed) timer = setTimeout(() => void tick(), intervalMs);
		};
		void tick();
	};

	const sendInitialSnapshot = async (): Promise<void> => {
		if (closed) return;
		try {
			const snapshot = await readPaneSnapshot(pane, source, format, stripAnsi, lines, session);
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

	// Live delta frames pass the backpressure guard; initial snapshots and
	// their pendingChunks replays bypass it (they ARE the recovery mechanism).
	const sendLiveFrame = (body: PaneOutputFrame): void => {
		const buffered = peerBufferedBytes(peer);
		if (buffered > BACKPRESSURE_DROP_BYTES) {
			needsResync = true;
			return;
		}
		if (needsResync) {
			if (buffered > BACKPRESSURE_RESYNC_BYTES) return;
			// Drained: replace the dropped bytes with a fresh full snapshot.
			// The snapshot read starts after this frame's output already hit
			// the terminal, so this frame is covered by it; frames arriving
			// while the read is in flight buffer through pendingChunks.
			needsResync = false;
			snapshotReady = false;
			pendingChunks = [];
			void sendInitialSnapshot();
			return;
		}
		sendFrame(body);
	};

	registerStream(peer, key, {
		close: () => {
			closed = true;
			terminalStream?.close();
			nativeStream?.close();
			if (timer) clearTimeout(timer);
		},
		terminal: () => (closed || fallbackStarted ? undefined : terminalStream),
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
				...(session === undefined ? {} : { session }),
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
					sendLiveFrame(body);
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
			sendLiveFrame(frame);
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
		session,
	);
}
