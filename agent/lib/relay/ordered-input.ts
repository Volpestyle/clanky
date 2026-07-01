/**
 * Relay ordered-input path — per-pane FIFO serialization of `write`/`keys`/
 * `run`/`send`, the stream-write ordering barrier between herdr's two input
 * injection channels, and the CLANKY_RELAY_TRACE latency breadcrumbs.
 */
import type { WebSocketPeer } from "eve/channels";
import { RELAY_TRACE, relayLogError } from "./log.ts";
import { liveTerminalStream, reply } from "./peers.ts";
import { str, type RelayRequest } from "./protocol.ts";
import { dispatch } from "./ops.ts";

const orderedInputQueues = new Map<string, Promise<void>>();

/*
 * Input ordering across the two herdr injection paths.
 *
 * `write` ops from a peer holding a live Native attach stream are injected as
 * ClientMessage::Input on herdr's persistent client socket (no per-op API
 * round trip — this kills the fresh-connection RTT tail on the typing hot
 * path). `keys` stays on the API socket because pane.send_keys is
 * terminal-mode-aware, and `run`/`send`/fallback `write` also use the API
 * socket. Inside herdr both paths end at the same per-terminal PTY byte sink,
 * applied in main-loop order — but they arrive over two different channels
 * (client-socket ServerEvent vs api_tx) merged by tokio::select!, so their
 * relative arrival order is NOT guaranteed.
 *
 * The per-pane FIFO below therefore keeps carrying every input op, and:
 *  - stream writes resolve immediately after the socket write (the FIFO no
 *    longer amplifies a herdr RTT per keystroke) and stamp lastStreamWriteAt;
 *  - an API-path input op that follows a stream write within
 *    STREAM_WRITE_ORDER_BARRIER_MS waits out the remainder of that window
 *    first, giving herdr's client-socket reader ample time to hand the prior
 *    write to the main loop before the API request lands;
 *  - API-path ops are awaited to completion (herdr replies only after the
 *    bytes hit the PTY sink), so a stream write can never overtake a
 *    previously dispatched API op.
 *
 * Residual risk: if herdr's main loop stalls longer than the barrier while
 * both messages are queued, select! may still pick the API op first. That
 * window is accepted in exchange for removing the per-keystroke RTT.
 */
const STREAM_WRITE_ORDER_BARRIER_MS = 15;
const lastStreamWriteAt = new Map<string, number>();

export function orderedInputKey(req: RelayRequest): string | undefined {
	// Scope the input-ordering key by session: pane ids are only unique within a
	// herdr session, so two sessions' same-id panes must not share a queue.
	const scope = str(req.args?.session) ?? "";
	switch (req.op) {
		case "write":
		case "keys":
		case "run": {
			const pane = str(req.args?.pane);
			return pane === undefined ? undefined : `${scope}|pane:${pane}`;
		}
		case "send": {
			const pane = str(req.args?.pane);
			if (pane !== undefined) return `${scope}|pane:${pane}`;
			const agent = str(req.args?.agent);
			return agent === undefined ? undefined : `${scope}|agent:${agent}`;
		}
		default:
			return undefined;
	}
}

/// Route one ordered input op to herdr. `write` prefers the requesting peer's
/// live Native attach stream (persistent client socket, resolves as soon as
/// the bytes are written); everything else — and `write` without a usable
/// stream — goes through the per-request API socket behind the stream-write
/// ordering barrier. See the ordering design note above lastStreamWriteAt.
async function dispatchOrderedInput(peer: WebSocketPeer, req: RelayRequest, key: string): Promise<unknown> {
	const args = req.args ?? {};
	if (req.op === "write") {
		const pane = str(args.pane);
		const text = typeof args.text === "string" ? args.text : undefined;
		if (!pane || text === undefined) throw new Error("write requires pane and text");
		const stream = liveTerminalStream(peer, pane, str(args.session));
		if (stream?.sendInput(Buffer.from(text, "utf8")) === true) {
			lastStreamWriteAt.set(key, Date.now());
			return { type: "ok", via: "stream" };
		}
	}
	const last = lastStreamWriteAt.get(key);
	if (last !== undefined) {
		lastStreamWriteAt.delete(key);
		const wait = STREAM_WRITE_ORDER_BARRIER_MS - (Date.now() - last);
		if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
	}
	return dispatch(req.op, args);
}

/// t_herdr_done is when the op's dispatch resolved: the herdr API reply for
/// API-path ops, or the client-socket write completing for stream writes
/// (ClientMessage::Input has no ack).
function traceOrderedInput(req: RelayRequest, tRx: number): void {
	if (!RELAY_TRACE || (req.op !== "write" && req.op !== "keys")) return;
	const t0 = typeof req.args?.t0 === "number" && Number.isFinite(req.args.t0) ? req.args.t0 : undefined;
	console.error(`relay input trace: ${JSON.stringify({ id: req.id, op: req.op, t0, t_rx: tRx, t_herdr_done: Date.now() })}`);
}

export function enqueueOrderedInput(peer: WebSocketPeer, req: RelayRequest, key: string, tRx: number): void {
	const previous = orderedInputQueues.get(key) ?? Promise.resolve();
	const next = previous
		.catch(() => {
			// Each queued request handles its own error and replies to its caller.
			// Keep the chain alive if a prior request failed.
		})
		.then(async () => {
			try {
				const result = await dispatchOrderedInput(peer, req, key);
				reply(peer, { id: req.id, ok: true, result });
				traceOrderedInput(req, tRx);
			} catch (error) {
				reply(peer, { id: req.id, ok: false, error: (error as Error).message });
			}
		})
		.catch((error: unknown) => {
			// The peer may have disconnected while its queued input was in flight.
			// Do not let a failed reply poison later input queued for this pane.
			relayLogError(`ordered input reply pipeline for ${key}`, error);
		});
	orderedInputQueues.set(key, next);
	void next.finally(() => {
		if (orderedInputQueues.get(key) === next) orderedInputQueues.delete(key);
	});
}
