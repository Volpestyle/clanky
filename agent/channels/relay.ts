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
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { promisify } from "node:util";
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
import { resolveClankyDataPath } from "../lib/paths.ts";
import { isAgentMdIngestionEnabled } from "../lib/agent-md.ts";
import { listClankySkills } from "../lib/skill-inventory.ts";
import { resolveWorkerTranscriptSetting } from "../lib/worker-transcripts.ts";

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
const MAX_RELAY_UPLOAD_BYTES = 25 * 1024 * 1024;
const RELAY_UPLOAD_DIR = "uploads/ios-terminal";
const REPO = process.env.CLANKY_REPO_DIR?.trim() || process.cwd();

const execFileAsync = promisify(execFile);

interface HerdrSessionInfo {
	name: string;
	default: boolean;
	running: boolean;
	socket_path?: string;
	session_dir?: string;
}

/// The herdr session the relay process itself is bound to (its env default). A
/// client that sends no `session` arg lands here, so the picker pre-selects it.
function boundSessionName(): string | undefined {
	const explicit = process.env.HERDR_SESSION?.trim();
	if (explicit) return explicit;
	const sock = process.env.HERDR_SOCKET_PATH?.trim();
	if (sock) {
		const match = sock.match(/\/sessions\/([^/]+)\/herdr\.sock$/);
		return match ? match[1] : undefined;
	}
	return "default";
}

/// Enumerate the herdr sessions on this host. herdr exposes no `session.list`
/// socket RPC, so we shell out to the CLI — the same path the Clanky TUI uses
/// (scripts/clanky.ts). Degrades to the single bound session if the CLI is
/// unavailable so a snapshot never fails just because enumeration did.
async function listHerdrSessions(): Promise<{ sessions: HerdrSessionInfo[]; bound?: string }> {
	const bound = boundSessionName();
	try {
		const { stdout } = await execFileAsync("herdr", ["session", "list", "--json"], { timeout: 2000, encoding: "utf8" });
		const parsed = JSON.parse(stdout) as { sessions?: HerdrSessionInfo[] };
		const sessions = Array.isArray(parsed.sessions) ? parsed.sessions : [];
		return { sessions, bound };
	} catch {
		return {
			sessions: [{ name: bound ?? "default", default: bound === undefined || bound === "default", running: true }],
			bound,
		};
	}
}

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

async function saveRelayUpload(args: Record<string, unknown>): Promise<unknown> {
	const kind = str(args.kind) ?? "image";
	if (kind !== "image") throw new Error("upload kind must be image");
	const data = str(args.data);
	if (data === undefined) throw new Error("upload requires base64 data");
	const mediaType = (str(args.media_type) ?? str(args.mediaType) ?? dataUrlMediaType(data) ?? "application/octet-stream").toLowerCase();
	if (!mediaType.startsWith("image/")) throw new Error("upload media_type must be an image type");
	const bytes = decodeUploadData(data);
	if (bytes.byteLength === 0) throw new Error("upload data is empty");
	if (bytes.byteLength > MAX_RELAY_UPLOAD_BYTES) {
		throw new Error(`upload is too large (${bytes.byteLength} bytes); maximum is ${MAX_RELAY_UPLOAD_BYTES}.`);
	}

	const dir = resolveClankyDataPath(RELAY_UPLOAD_DIR);
	await mkdir(dir, { recursive: true, mode: 0o700 });
	const filename = uploadFilename(str(args.filename), mediaType);
	const path = join(dir, filename);
	await writeFile(path, bytes, { mode: 0o600 });
	return {
		type: "upload",
		kind,
		path,
		filename,
		media_type: mediaType,
		bytes: bytes.byteLength,
		directive: `@image ${path}`,
	};
}

function dataUrlMediaType(data: string): string | undefined {
	return /^data:([^;,]+)?;base64,/iu.exec(data.trim())?.[1];
}

function decodeUploadData(data: string): Buffer {
	const match = /^data:([^;,]+)?;base64,(.*)$/iu.exec(data.trim());
	const encoded = (match?.[2] ?? data).replace(/\s+/gu, "");
	if (!/^[A-Za-z0-9+/]*={0,2}$/u.test(encoded) || encoded.length % 4 === 1) {
		throw new Error("upload data is not valid base64");
	}
	return Buffer.from(encoded, "base64");
}

function uploadFilename(filename: string | undefined, mediaType: string): string {
	const original = basename(filename ?? "image");
	const ext = extensionForMediaType(mediaType);
	const originalExt = extname(original);
	const stem = (originalExt.length > 0 ? original.slice(0, -originalExt.length) : original)
		.replace(/[^A-Za-z0-9._-]+/gu, "-")
		.replace(/^-+|-+$/gu, "")
		.slice(0, 80) || "image";
	return `${stem}-${Date.now()}-${randomUUID()}.${ext}`;
}

function extensionForMediaType(mediaType: string): string {
	const sub = mediaType.split("/")[1]?.split(";")[0]?.trim().toLowerCase();
	switch (sub) {
		case "jpeg":
		case "jpg":
			return "jpg";
		case "svg+xml":
			return "svg";
		case "heic":
		case "heif":
		case "png":
		case "gif":
		case "webp":
		case "avif":
		case "tiff":
		case "bmp":
			return sub;
		default:
			return "img";
	}
}

async function herdrReadWithFullFallback(
	method: "pane.read" | "agent.read",
	params: Record<string, unknown>,
	session?: string,
): Promise<unknown> {
	try {
		return await herdrRequest(method, params, session);
	} catch (error) {
		if (params.source !== "full" || !isUnsupportedFullSourceError(error)) throw error;
		const fallbackParams = {
			...params,
			source: "recent_unwrapped",
			lines: VANILLA_HERDR_FALLBACK_LINES,
		};
		const fallback = await herdrRequest(method, fallbackParams, session);
		return annotateFullFallback(fallback, (error as Error).message);
	}
}

// Map a relay op to a herdr socket API request. Returns the decoded result.
async function dispatch(op: string, args: Record<string, unknown>): Promise<unknown> {
	const target = str(args.agent) ?? str(args.pane);
	// Per-request herdr session targeting: every socket call in this op routes to
	// the session the client selected, or the relay's env-bound default when the
	// client omits one. See herdrSocketPath() for how the token resolves.
	const session = str(args.session);
	const hreq = (method: string, params: Record<string, unknown> = {}) => herdrRequest(method, params, session);
	switch (op) {
		case "api": {
			const method = str(args.method);
			if (!method) throw new Error("api requires method");
			return hreq(method, rec(args.params));
		}
		case "health":
			return hreq("ping");
		case "list":
			return hreq("agent.list");
		case "sessions":
			return listHerdrSessions();
		case "list-skills": {
			const agentMdEnabled = isAgentMdIngestionEnabled();
			return {
				type: "skills",
				agentMdEnabled,
				skills: await listClankySkills(REPO, { includeInherited: agentMdEnabled }),
			};
		}
		case "workspaces":
			return hreq("workspace.list");
		case "tabs":
			return hreq("tab.list", args.workspace_id ? { workspace_id: args.workspace_id } : {});
		case "panes":
			return hreq("pane.list", args.workspace_id ? { workspace_id: args.workspace_id } : {});
		case "create-tab": {
			const workspaceId = str(args.workspace_id);
			const cwd = str(args.cwd);
			const label = str(args.label);
			const focus = args.focus === true;
			const argv = Array.isArray(args.argv) ? (args.argv as unknown[]).map(String).filter((part) => part.length > 0) : [];
			if (argv.length === 0) throw new Error("create-tab requires argv[]");

			const root: Record<string, unknown> = { type: "pane", command: argv };
			if (cwd !== undefined) root.cwd = cwd;

			const result = await hreq("layout.apply", {
				...(workspaceId === undefined ? {} : { workspace_id: workspaceId }),
				...(label === undefined ? {} : { tab_label: label }),
				focus,
				root,
			});
			const layout = rec(rec(result).layout);
			return {
				workspace_id: str(layout.workspace_id),
				tab_id: str(layout.tab_id),
				pane_id: str(layout.focused_pane_id),
				layout: result,
			};
		}
		case "get":
			if (!target) throw new Error("get requires agent or pane");
			return args.pane ? hreq("pane.get", { pane_id: target }) : hreq("agent.get", { target });
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
					const result = await hreq("agent.read", { target, source: "recent_unwrapped", lines: requestedLines });
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
				const result = await hreq("pane.read", { pane_id: target, source: "recent_unwrapped", lines: requestedLines });
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
				? herdrReadWithFullFallback("pane.read", params, session)
				: herdrReadWithFullFallback("agent.read", params, session);
		}
		case "send": {
			const text = str(args.text);
			if (!target || text === undefined) throw new Error("send requires agent/pane and text");
			return args.pane
				? hreq("pane.send_input", { pane_id: target, text, keys: ["Enter"] })
				: hreq("agent.send", { target, text });
		}
		case "run": {
			const pane = str(args.pane);
			const text = str(args.text);
			if (!pane || text === undefined) throw new Error("run requires pane and text");
			return hreq("pane.send_input", { pane_id: pane, text, keys: ["Enter"] });
		}
		case "keys": {
			const pane = str(args.pane);
			const keys = Array.isArray(args.keys) ? (args.keys as unknown[]).map(String) : [];
			if (!pane || keys.length === 0) throw new Error("keys requires pane and keys[]");
			return hreq("pane.send_keys", { pane_id: pane, keys });
		}
		case "upload":
			return saveRelayUpload(args);
		case "start": {
			const name = str(args.name);
			const argv = Array.isArray(args.argv) ? (args.argv as unknown[]).map(String) : [];
			if (!name || argv.length === 0) throw new Error("start requires name and argv[]");
			const cwd = str(args.cwd) ?? process.cwd();
			// Remote-spawned workers funnel through the same transcript seam as the
			// eve herdr_spawn tool and the operator spawn.sh, so a button in the iOS
			// app uses the same default/override policy as a model tool call
			// (SPEC.md §4.3). The raw `op:"api" method:"agent.start"` passthrough
			// stays the explicit escape hatch that never applies transcript policy.
			const transcriptOverride = typeof args.transcript === "boolean" ? args.transcript : undefined;
			const launchArgv = resolveWorkerTranscriptSetting({ override: transcriptOverride })
				? wrapTranscriptArgv({ agent: name, cwd, runId: newTranscriptRunId(), argv })
				: argv;
			const split = str(args.split);
			if (split !== undefined && split !== "right" && split !== "down") throw new Error("start split must be right or down");
			const explicitPlacement: HerdrPanePlacement = {
				...(str(args.workspace_id) === undefined ? {} : { workspace_id: str(args.workspace_id) }),
				...(str(args.tab_id) === undefined ? {} : { tab_id: str(args.tab_id) }),
				...(str(args.target_pane_id) === undefined ? {} : { target_pane_id: str(args.target_pane_id) }),
			};
			const hasExplicitPlacement = Object.keys(explicitPlacement).length > 0;
			// The Clanky face placement (CLANKY_FACE_* env / clanky:main) only exists
			// in the relay's bound session. When the client targets a different
			// session, skip it and let herdr place the new pane there.
			const targetsBoundSession = session === undefined || session === boundSessionName();
			const placement = hasExplicitPlacement
				? explicitPlacement
				: targetsBoundSession
					? await resolveClankyFacePanePlacement(undefined, session)
					: {};
			return startHerdrAgentNearPlacement({
				name,
				argv: launchArgv,
				cwd,
				focus: args.focus === true,
				...(split === undefined ? {} : { split }),
				placement,
				...(session === undefined ? {} : { session }),
			});
		}
		case "close": {
			const pane = str(args.pane);
			if (!pane) throw new Error("close requires pane");
			return hreq("pane.close", { pane_id: pane });
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
			return hreq("pane.send_text", { pane_id: pane, text });
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
const orderedInputQueues = new Map<string, Promise<void>>();

// Live TUI faces attached via a `face-attach` op. Presence = connection alive;
// a face dropping (crash or quit) clears on the WS `close` hook. Surfaced in
// `/relay/health` as `face` so clients can show a visible UI vs headless mode.
const facePeers = new Set<WebSocketPeer>();

// Command hosts are below the relay and own deterministic slash-command
// execution. A visible face may also be a command host, but iOS should depend on
// this capability, not on the visible TUI being open.
const commandPeers = new Set<WebSocketPeer>();

type PendingCommand = {
	readonly client: WebSocketPeer;
	readonly clientRequestId: RelayRequest["id"];
	readonly host: WebSocketPeer;
};

const pendingCommands = new Map<string, PendingCommand>();

function facePresence(): { attached: boolean; count: number } {
	return { attached: facePeers.size > 0, count: facePeers.size };
}

function commandPresence(): { attached: boolean; count: number } {
	return { attached: commandPeers.size > 0, count: commandPeers.size };
}

function attachedCommandPeer(): WebSocketPeer | undefined {
	for (const peer of commandPeers) {
		if (!facePeers.has(peer)) return peer;
	}
	return commandPeers.values().next().value ?? facePeers.values().next().value;
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

function orderedInputKey(req: RelayRequest): string | undefined {
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

function enqueueOrderedInput(peer: WebSocketPeer, req: RelayRequest, key: string): void {
	const previous = orderedInputQueues.get(key) ?? Promise.resolve();
	const next = previous
		.catch(() => {
			// Each queued request handles its own error and replies to its caller.
			// Keep the chain alive if a prior request failed.
		})
		.then(async () => {
			try {
				const result = await dispatch(req.op, req.args ?? {});
				reply(peer, { id: req.id, ok: true, result });
			} catch (error) {
				reply(peer, { id: req.id, ok: false, error: (error as Error).message });
			}
		})
		.catch(() => {
			// The peer may have disconnected while its queued input was in flight.
			// Do not let a failed reply poison later input queued for this pane.
		});
	orderedInputQueues.set(key, next);
	void next.finally(() => {
		if (orderedInputQueues.get(key) === next) orderedInputQueues.delete(key);
	});
}

function startCommand(peer: WebSocketPeer, req: RelayRequest): void {
	const host = attachedCommandPeer();
	if (host === undefined) throw new Error("No Clanky command host is attached. Start Clanky before running native slash commands.");
	const commandLine = str(req.args?.command_line) ?? str(req.args?.commandLine);
	if (commandLine === undefined) throw new Error(`${req.op} requires command_line`);
	const commandId = requestId(req.id);
	pendingCommands.set(commandId, { client: peer, clientRequestId: req.id, host });
	reply(host, { type: commandPeers.has(host) ? "command.request" : "face.command.request", id: commandId, commandLine });
}

function forwardCommandEvent(peer: WebSocketPeer, req: RelayRequest): void {
	const commandId = str(req.args?.request_id) ?? str(req.args?.requestID) ?? requestId(req.id);
	const event = req.args?.event;
	const pending = pendingCommands.get(commandId);
	if (pending === undefined) return;
	if (pending.host !== peer) throw new Error(`${req.op} came from a different command host`);
	reply(pending.client, { id: pending.clientRequestId, ok: true, stream: true, body: event });
	if (isTerminalCommandEvent(event)) pendingCommands.delete(commandId);
}

function forwardCommandClientMessage(peer: WebSocketPeer, req: RelayRequest): void {
	const commandId = str(req.args?.request_id) ?? str(req.args?.requestID);
	const message = req.args?.message;
	if (commandId === undefined) throw new Error(`${req.op} requires request_id`);
	const pending = pendingCommands.get(commandId);
	if (pending === undefined) throw new Error("No pending command for request_id");
	if (pending.client !== peer) throw new Error(`${req.op} came from a different client peer`);
	reply(pending.host, { type: commandPeers.has(pending.host) ? "command.client" : "face.command.client", id: commandId, message });
	reply(peer, { id: req.id, ok: true, result: { sent: true } });
}

function closePendingCommandsFor(peer: WebSocketPeer): void {
	for (const [commandId, pending] of pendingCommands) {
		if (pending.client !== peer && pending.host !== peer) continue;
		pendingCommands.delete(commandId);
		if (pending.client === peer) {
			reply(pending.host, {
				type: commandPeers.has(pending.host) ? "command.client" : "face.command.client",
				id: commandId,
				message: { type: "menu.cancel", sessionId: commandId },
			});
			continue;
		}
		if (pending.host === peer) {
			reply(pending.client, {
				id: pending.clientRequestId,
				ok: true,
				stream: true,
				body: {
					type: "menu.failed",
					sessionId: commandId,
					message: "The Clanky command host disconnected before the command finished.",
				},
			});
		}
	}
}

function isTerminalCommandEvent(event: unknown): boolean {
	if (event === null || typeof event !== "object" || Array.isArray(event)) return false;
	const type = (event as { type?: unknown }).type;
	return type === "menu.end" || type === "menu.failed";
}

function subscribe(peer: WebSocketPeer, req: RelayRequest): void {
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
		(error) => reply(peer, { id: req.id, ok: false, stream: true, error: error.message }),
		undefined,
		session,
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
	const session = str(args.session);
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
				const snapshot = await readPaneSnapshot(pane, source, format, stripAnsi, lines, session);
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
		session,
	);
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
						enqueueOrderedInput(peer, req, inputKey);
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
				commandPeers.delete(peer);
				closePendingCommandsFor(peer);
				closeStream(peer);
			},
		})),
	],
});
