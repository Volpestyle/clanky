/**
 * Relay request/response ops — dispatch() maps a relay op to a herdr socket
 * API request (plus the local handlers: session enumeration, skill listing,
 * uploads, push registration) and returns the decoded result. Streaming ops
 * (attach/subscribe) and command brokering live in their own modules.
 */
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { promisify } from "node:util";
import { resolveClankyFacePanePlacement, startHerdrAgentNearPlacement, type HerdrPanePlacement } from "../herdr-placement.ts";
import { closeIosChatMirror, mirrorIosChat } from "../ios/chat-mirror-spawn.ts";
import { herdrRequest } from "../herdr-socket.ts";
import { parsePushPlatform, registerPushDevice, unregisterPushDevice } from "../push-registry.ts";
import { ensurePushWatcher } from "../push-watcher.ts";
import { apnsConfigured } from "../apns.ts";
import { fcmConfigured } from "../fcm.ts";
import { readPaneRecording } from "../pane-recorder.ts";
import { newTranscriptRunId, readTranscript } from "../transcripts.ts";
import { wrapTranscriptArgv } from "../../tools/herdr_spawn.ts";
import { resolveClankyDataPath } from "../paths.ts";
import { isAgentMdIngestionEnabled } from "../agent-md.ts";
import { listClankySkills } from "../skill-inventory.ts";
import { resolveWorkerTranscriptSetting } from "../worker-transcripts.ts";
import { relayTrace } from "./log.ts";
import { hasOwn, MAX_RELAY_UPLOAD_BYTES, num, rec, str } from "./protocol.ts";

export const VANILLA_HERDR_FALLBACK_LINES = 1000;
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
export function boundSessionName(): string | undefined {
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
	} catch (error) {
		relayTrace(`herdr session list unavailable, degrading to bound session: ${(error as Error).message}`);
		return {
			sessions: [{ name: bound ?? "default", default: bound === undefined || bound === "default", running: true }],
			bound,
		};
	}
}

export function isUnsupportedFullSourceError(error: unknown): boolean {
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
export async function dispatch(op: string, args: Record<string, unknown>): Promise<unknown> {
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
			if (args.pane && source === "recording") {
				return readPaneRecording(target, {
					lines: requestedLines,
					anchor: str(args.anchor) === "head" ? "head" : "tail",
					skip: num(args.skip, 0),
					recordingId: str(args.recording_id),
				});
			}
			if (args.pane && source === "auto") {
				try {
					return await readPaneRecording(target, {
						lines: requestedLines,
						anchor: str(args.anchor) === "head" ? "head" : "tail",
						skip: num(args.skip, 0),
						recordingId: str(args.recording_id),
					});
				} catch (error) {
					const result = await hreq("pane.read", { pane_id: target, source: "recent_unwrapped", lines: requestedLines });
					return {
						source: "herdr-recent-unwrapped",
						fallback: true,
						fallbackReason: (error as Error).message,
						pane: target,
						lines: requestedLines,
						text: herdrText(result),
						herdr: result,
					};
				}
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
		case "chat.mirror": {
			// Bind an iOS native chat to a herdr pane mirror (ADR-0004): a one-pane tab
			// in the requested/default workspace, tailing the eve session read-only.
			// Idempotent by the device-remembered {tab_id, pane_id} handles; live
			// handles win over workspace targeting.
			const sessionId = str(args.session_id);
			const slug = str(args.slug);
			if (sessionId === undefined || slug === undefined) throw new Error("chat.mirror requires session_id and slug");
			const title = str(args.title);
			const tabId = str(args.tab_id);
			const paneId = str(args.pane_id);
			const workspaceId = str(args.workspace_id);
			const workspaceLabel = str(args.workspace_label);
			return mirrorIosChat({
				sessionId,
				slug,
				...(title === undefined ? {} : { title }),
				...(tabId === undefined ? {} : { tabId }),
				...(paneId === undefined ? {} : { paneId }),
				...(workspaceId === undefined ? {} : { workspaceId }),
				...(workspaceLabel === undefined ? {} : { workspaceLabel }),
				...(session === undefined ? {} : { session }),
			});
		}
		case "chat.close": {
			// Tear down an iOS chat's presence: close the mirror pane, and its tab when
			// close_tab is set (ADR-0004). Handles are the device-remembered ids.
			const tabId = str(args.tab_id);
			const paneId = str(args.pane_id);
			return closeIosChatMirror({
				...(tabId === undefined ? {} : { tabId }),
				...(paneId === undefined ? {} : { paneId }),
				...(args.close_tab === true ? { closeTab: true } : {}),
				...(session === undefined ? {} : { session }),
			});
		}
		case "register-push": {
			// Mobile clients register their APNs/FCM device token after pairing so
			// Clanky can push when an agent goes blocked/done/error. Starts the
			// watcher lazily.
			const token = str(args.token);
			if (!token) throw new Error("register-push requires token");
			const events = Array.isArray(args.events) ? (args.events as unknown[]).map(String) : [];
			const platform = hasOwn(args, "platform") ? parsePushPlatform(args.platform) : "ios";
			if (platform === undefined) throw new Error("register-push platform must be ios or android");
			await registerPushDevice({ token, platform, events });
			ensurePushWatcher();
			return { ok: true, registered: true, platform, apnsConfigured: apnsConfigured(), fcmConfigured: fcmConfigured() };
		}
		case "unregister-push": {
			const token = str(args.token);
			if (!token) throw new Error("unregister-push requires token");
			const platform = hasOwn(args, "platform") ? parsePushPlatform(args.platform) : undefined;
			if (hasOwn(args, "platform") && platform === undefined) throw new Error("unregister-push platform must be ios or android");
			await unregisterPushDevice(token, platform);
			return { ok: true, unregistered: true };
		}
		case "write": {
			// Raw verbatim input — the keystroke path for the iOS live terminal
			// (SPEC.md §4.3). herdr's pane.send_text writes the bytes to the PTY
			// master unchanged, so typed text, control sequences (Ctrl-C as \x03),
			// and arrow-key escapes (\x1b[A) all pass through faithfully. Unlike
			// `run`/`send`, this appends NO trailing Enter — the client owns newlines.
			// This is the API-socket fallback: when the requesting peer holds a
			// live Native attach stream for the pane, dispatchOrderedInput routes
			// the write over that stream instead and never reaches here.
			const pane = str(args.pane);
			const text = typeof args.text === "string" ? args.text : undefined;
			if (!pane || text === undefined) throw new Error("write requires pane and text");
			return hreq("pane.send_text", { pane_id: pane, text });
		}
		default:
			throw new Error(`unknown op '${op}'`);
	}
}

export function herdrText(result: unknown): string {
	if (typeof result === "string") return result;
	if (typeof result === "object" && result !== null && "text" in result) {
		const text = (result as { text?: unknown }).text;
		if (typeof text === "string") return text;
	}
	return JSON.stringify(result);
}
