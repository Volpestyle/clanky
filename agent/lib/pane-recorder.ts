/**
 * Session-wide pane recorder (SPEC.md §4.3, ADR-0007).
 *
 * The observational capture plane: attaches to every pane in the connected
 * herdr session via `pane.attach`, seeds each attach epoch with a `pane.read`
 * snapshot, and persists per-pane recordings under the transcript root at
 * `<root>/<session>/panes/<recording-id>/`. Complements — never replaces —
 * the in-path worker-transcript wrapper: panes covered by `transcript-run`
 * are recorded lifecycle-only by default so bytes are stored once.
 *
 * Herdr without `pane.attach` (pre-0.7.1) degrades to seed-only capture:
 * lifecycle events and bounded `pane.read` snapshots, marked
 * `attach-unsupported` in events.jsonl.
 */
import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { gunzip, gzip } from "node:zlib";
import { herdrRequest, herdrStreamLines, type HerdrStream } from "./herdr-socket.ts";
import {
	normalizeTerminalText,
	resolveTranscriptRoot,
	resolveTranscriptSession,
	splitPendingEscape,
	transcriptPathSegment,
} from "./transcripts.ts";

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);

export const PANE_RECORDING_SOURCE = "clanky-pane-recording" as const;
/** Reserved dir name under the per-session transcript root (never an agent name). */
export const PANE_RECORDINGS_DIR = "panes" as const;

const DEFAULT_RECORDING_BUDGETS: PaneRecordingBudgets = {
	segmentRotateBytes: 16 * 1024 * 1024,
	recordingMaxBytes: 256 * 1024 * 1024,
};
/** Lines captured per attach-epoch seed snapshot (herdr's server-side read cap). */
const SEED_LINES = 1000;
const ATTACH_BACKOFF_MIN_MS = 1_000;
const ATTACH_BACKOFF_MAX_MS = 30_000;
const EVENTS_RECONNECT_MIN_MS = 1_000;
const EVENTS_RECONNECT_MAX_MS = 60_000;
const LOCK_FILE = ".recorder.lock";
const LOCK_HEARTBEAT_MS = 30_000;
const LOCK_STALE_MS = 120_000;

export interface PaneRecordingManifest {
	version: 1;
	kind: "pane-recording";
	session: string;
	recordingId: string;
	paneId: string;
	workspaceId?: string;
	tabId?: string;
	terminalId?: string;
	agent?: string;
	label?: string;
	startedAt: string;
	endedAt?: string;
	endReason?: string;
	/** Set when the pane's bytes already land in a worker transcript. */
	coveredBy?: "worker-transcript";
}

export interface PaneRecordingBudgets {
	/** Rotate active stream files once stream.ansi passes this size. */
	segmentRotateBytes: number;
	/** Per-recording byte cap; oldest archives are pruned at rotation to stay under. */
	recordingMaxBytes: number;
}

export interface PaneRecording {
	dir: string;
	manifestPath: string;
	eventsPath: string;
	ansiPath: string;
	textPath: string;
	manifest: PaneRecordingManifest;
	budgets: PaneRecordingBudgets;
	/** Bytes withheld from stream.txt because an escape sequence spans chunks. */
	pendingEscape: string;
	/** Serializes appends + rotation per recording. */
	writeChain: Promise<void>;
}

export interface PaneRecordingSummary {
	session: string;
	recordingId: string;
	paneId: string;
	terminalId?: string;
	agent?: string;
	label?: string;
	startedAt: string;
	endedAt?: string;
	coveredBy?: "worker-transcript";
	path: string;
}

export interface PaneRecordingRead {
	source: typeof PANE_RECORDING_SOURCE;
	fallback: false;
	session: string;
	paneId: string;
	recordingId: string;
	path: string;
	anchor: "head" | "tail";
	skip: number;
	lines: number;
	text: string;
	coveredBy?: "worker-transcript";
	/** True when only seed snapshots exist (recorder ran in degraded mode). */
	seededOnly?: boolean;
}

interface PaneInfoLike {
	pane_id: string;
	workspace_id?: string;
	tab_id?: string;
	terminal_id?: string;
	agent?: string;
	label?: string;
}

export function resolvePaneRecordingsRoot(env: NodeJS.ProcessEnv = process.env): string {
	return join(resolveTranscriptRoot(env), PANE_RECORDINGS_DIR);
}

function newRecordingId(paneId: string, now = new Date()): string {
	const stamp = now.toISOString().replace(/[-:.TZ]/g, "");
	return `${stamp}-${randomUUID().slice(0, 4)}-${transcriptPathSegment(paneId, "pane id")}`;
}

function recordingFromManifest(
	dir: string,
	manifest: PaneRecordingManifest,
	budgets: PaneRecordingBudgets = DEFAULT_RECORDING_BUDGETS,
): PaneRecording {
	return {
		dir,
		manifestPath: join(dir, "manifest.json"),
		eventsPath: join(dir, "events.jsonl"),
		ansiPath: join(dir, "stream.ansi"),
		textPath: join(dir, "stream.txt"),
		manifest,
		budgets,
		pendingEscape: "",
		writeChain: Promise.resolve(),
	};
}

export async function createPaneRecording(
	pane: PaneInfoLike,
	options: {
		env?: NodeJS.ProcessEnv;
		now?: Date;
		coveredBy?: "worker-transcript";
		budgets?: PaneRecordingBudgets;
	} = {},
): Promise<PaneRecording> {
	const now = options.now ?? new Date();
	const manifest: PaneRecordingManifest = {
		version: 1,
		kind: "pane-recording",
		session: resolveTranscriptSession(options.env),
		recordingId: newRecordingId(pane.pane_id, now),
		paneId: pane.pane_id,
		...(pane.workspace_id === undefined ? {} : { workspaceId: pane.workspace_id }),
		...(pane.tab_id === undefined ? {} : { tabId: pane.tab_id }),
		...(pane.terminal_id === undefined ? {} : { terminalId: pane.terminal_id }),
		...(pane.agent === undefined ? {} : { agent: pane.agent }),
		...(pane.label === undefined ? {} : { label: pane.label }),
		startedAt: now.toISOString(),
		...(options.coveredBy === undefined ? {} : { coveredBy: options.coveredBy }),
	};
	const dir = join(resolvePaneRecordingsRoot(options.env), manifest.recordingId);
	const recording = recordingFromManifest(dir, manifest, options.budgets);
	await mkdir(dir, { recursive: true });
	await Promise.all([
		writeFile(recording.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`),
		writeFile(recording.ansiPath, ""),
		writeFile(recording.textPath, ""),
	]);
	await appendRecordingEvent(recording, { event: "created", paneId: manifest.paneId });
	return recording;
}

export async function appendRecordingEvent(
	recording: PaneRecording,
	event: Record<string, unknown>,
	now = new Date(),
): Promise<void> {
	await appendFile(recording.eventsPath, `${JSON.stringify({ at: now.toISOString(), ...event })}\n`);
}

/**
 * Append one decoded pane.attach chunk. stream.ansi stays the lossless raw
 * record; stream.txt gets the normalized readable form with escape sequences
 * that span chunks carried across appends. Rotation runs inline on the same
 * serialized chain so a rotation never interleaves with an append.
 */
export function appendRecordingChunk(recording: PaneRecording, chunk: Buffer): Promise<void> {
	recording.writeChain = recording.writeChain.then(async () => {
		const combined = recording.pendingEscape + chunk.toString("utf8");
		const { done, pending } = splitPendingEscape(combined);
		recording.pendingEscape = pending;
		const text = normalizeTerminalText(done);
		await appendFile(recording.ansiPath, chunk);
		if (text.length > 0) await appendFile(recording.textPath, text);
		await maybeRotateRecording(recording);
	});
	return recording.writeChain;
}

export async function writeRecordingSeed(recording: PaneRecording, text: string, reason: string): Promise<void> {
	const index = (await listNumberedFiles(recording.dir, /^seed-(\d{6})\.txt$/)).length + 1;
	const name = `seed-${String(index).padStart(6, "0")}.txt`;
	await writeFile(join(recording.dir, name), text);
	await appendRecordingEvent(recording, { event: "seed", file: name, reason, lines: text.split("\n").length });
}

export async function finalizePaneRecording(recording: PaneRecording, reason: string, now = new Date()): Promise<void> {
	recording.manifest = { ...recording.manifest, endedAt: now.toISOString(), endReason: reason };
	await writeFile(recording.manifestPath, `${JSON.stringify(recording.manifest, null, 2)}\n`);
	await appendRecordingEvent(recording, { event: "finalized", reason }, now);
}

async function maybeRotateRecording(recording: PaneRecording): Promise<void> {
	const ansiInfo = await stat(recording.ansiPath).catch(() => undefined);
	if (ansiInfo === undefined || ansiInfo.size < recording.budgets.segmentRotateBytes) return;
	const archives = await listNumberedFiles(recording.dir, /^archive-(\d{6})\.ansi\.gz$/);
	const index = String(archives.length + 1).padStart(6, "0");
	for (const [active, archived] of [
		[recording.ansiPath, join(recording.dir, `archive-${index}.ansi.gz`)],
		[recording.textPath, join(recording.dir, `archive-${index}.txt.gz`)],
	] as const) {
		const content = await readFile(active).catch(() => undefined);
		if (content === undefined) continue;
		// Compress to a temp name first so a crash mid-rotate never leaves a
		// half-written archive masquerading as a complete one.
		const partial = `${archived}.partial`;
		await writeFile(partial, await gzipAsync(content));
		await rename(partial, archived);
		await writeFile(active, "");
	}
	await appendRecordingEvent(recording, { event: "rotate", archive: `archive-${index}` });
	await pruneRecordingArchives(recording);
}

/** Enforce the recording byte cap by deleting oldest archive pairs first. */
async function pruneRecordingArchives(recording: PaneRecording): Promise<void> {
	const entries = await readdir(recording.dir).catch(() => [] as string[]);
	let total = 0;
	const sizes = new Map<string, number>();
	for (const name of entries) {
		const info = await stat(join(recording.dir, name)).catch(() => undefined);
		if (info === undefined || !info.isFile()) continue;
		sizes.set(name, info.size);
		total += info.size;
	}
	if (total <= recording.budgets.recordingMaxBytes) return;
	const archives = entries.filter((name) => /^archive-\d{6}\.(ansi|txt)\.gz$/.test(name)).sort();
	for (const name of archives) {
		if (total <= recording.budgets.recordingMaxBytes) break;
		await rm(join(recording.dir, name), { force: true });
		total -= sizes.get(name) ?? 0;
		await appendRecordingEvent(recording, { event: "prune", file: name });
	}
}

async function listNumberedFiles(dir: string, pattern: RegExp): Promise<string[]> {
	const entries = await readdir(dir).catch(() => [] as string[]);
	return entries.filter((name) => pattern.test(name)).sort();
}

export async function listPaneRecordings(env: NodeJS.ProcessEnv = process.env): Promise<PaneRecordingSummary[]> {
	const root = resolvePaneRecordingsRoot(env);
	const entries = await readdir(root, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
		if (error.code === "ENOENT") return [];
		throw error;
	});
	const summaries: PaneRecordingSummary[] = [];
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		const dir = join(root, entry.name);
		const manifest = await readRecordingManifest(join(dir, "manifest.json")).catch(() => undefined);
		if (manifest === undefined) continue;
		summaries.push({
			session: manifest.session,
			recordingId: manifest.recordingId,
			paneId: manifest.paneId,
			terminalId: manifest.terminalId,
			agent: manifest.agent,
			label: manifest.label,
			startedAt: manifest.startedAt,
			endedAt: manifest.endedAt,
			coveredBy: manifest.coveredBy,
			path: dir,
		});
	}
	return summaries.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

export async function openPaneRecording(dir: string): Promise<PaneRecording> {
	const manifest = await readRecordingManifest(join(dir, "manifest.json"));
	return recordingFromManifest(dir, manifest);
}

/** Latest recording for a pane id ("w1:p3" exact, or bare "p3" suffix). */
export async function findPaneRecording(
	pane: string,
	options: { recordingId?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<PaneRecordingSummary | undefined> {
	const recordings = await listPaneRecordings(options.env);
	if (options.recordingId !== undefined) {
		return recordings.find((recording) => recording.recordingId === options.recordingId);
	}
	return recordings.find(
		(recording) => recording.paneId === pane || recording.paneId.endsWith(`:${pane}`),
	);
}

/**
 * Read a line window from a recording's normalized text across rotated
 * archives and the active stream, in capture order. `anchor: "tail"` reads the
 * newest lines (skip counts back from the end); `anchor: "head"` reads from
 * the beginning (skip counts forward). Falls back to the newest seed snapshot
 * when no streamed text exists.
 */
export async function readPaneRecording(
	pane: string,
	options: {
		lines?: number;
		anchor?: "head" | "tail";
		skip?: number;
		recordingId?: string;
		env?: NodeJS.ProcessEnv;
	} = {},
): Promise<PaneRecordingRead> {
	const lines = options.lines ?? 120;
	const anchor = options.anchor ?? "tail";
	const skip = options.skip ?? 0;
	if (!Number.isInteger(lines) || lines < 1) throw new Error(`lines must be a positive integer; got ${lines}`);
	if (!Number.isInteger(skip) || skip < 0) throw new Error(`skip must be a non-negative integer; got ${skip}`);
	const summary = await findPaneRecording(pane, options);
	if (summary === undefined) throw new Error(`no pane recording found for ${pane}`);
	const segmentNames = [
		...(await listNumberedFiles(summary.path, /^archive-(\d{6})\.txt\.gz$/)),
		"stream.txt",
	];
	let text: string;
	let seededOnly = false;
	if (anchor === "head") {
		text = await collectHeadLines(summary.path, segmentNames, skip, lines);
	} else {
		text = await collectTailLines(summary.path, segmentNames, skip, lines);
	}
	if (text.length === 0) {
		const seeds = await listNumberedFiles(summary.path, /^seed-(\d{6})\.txt$/);
		const newest = seeds[seeds.length - 1];
		if (newest !== undefined) {
			seededOnly = true;
			const seedText = await readFile(join(summary.path, newest), "utf8").catch(() => "");
			text = anchor === "head" ? headLines(seedText, skip, lines) : tailLines(seedText, skip, lines);
		}
	}
	return {
		source: PANE_RECORDING_SOURCE,
		fallback: false,
		session: summary.session,
		paneId: summary.paneId,
		recordingId: summary.recordingId,
		path: summary.path,
		anchor,
		skip,
		lines,
		text,
		...(summary.coveredBy === undefined ? {} : { coveredBy: summary.coveredBy }),
		...(seededOnly ? { seededOnly } : {}),
	};
}

async function readSegmentText(dir: string, name: string): Promise<string> {
	const raw = await readFile(join(dir, name)).catch(() => undefined);
	if (raw === undefined || raw.length === 0) return "";
	if (!name.endsWith(".gz")) return raw.toString("utf8");
	return (await gunzipAsync(raw)).toString("utf8");
}

function segmentLines(text: string): string[] {
	if (text.length === 0) return [];
	const body = text.endsWith("\n") ? text.slice(0, -1) : text;
	return body.split("\n");
}

async function collectHeadLines(dir: string, segments: string[], skip: number, lines: number): Promise<string> {
	const collected: string[] = [];
	let remainingSkip = skip;
	for (const name of segments) {
		if (collected.length >= lines) break;
		for (const line of segmentLines(await readSegmentText(dir, name))) {
			if (remainingSkip > 0) {
				remainingSkip -= 1;
				continue;
			}
			collected.push(line);
			if (collected.length >= lines) break;
		}
	}
	return collected.length === 0 ? "" : `${collected.join("\n")}\n`;
}

async function collectTailLines(dir: string, segments: string[], skip: number, lines: number): Promise<string> {
	// One pass, keeping only the last (lines + skip) lines seen — bounded
	// memory even when archives hold millions of lines.
	const keep = lines + skip;
	let window: string[] = [];
	for (const name of segments) {
		const next = segmentLines(await readSegmentText(dir, name));
		if (next.length === 0) continue;
		window = window.concat(next);
		if (window.length > keep) window = window.slice(window.length - keep);
	}
	const end = skip === 0 ? window.length : Math.max(0, window.length - skip);
	const selected = window.slice(Math.max(0, end - lines), end);
	return selected.length === 0 ? "" : `${selected.join("\n")}\n`;
}

function headLines(text: string, skip: number, lines: number): string {
	const parts = segmentLines(text);
	const selected = parts.slice(skip, skip + lines);
	return selected.length === 0 ? "" : `${selected.join("\n")}\n`;
}

function tailLines(text: string, skip: number, lines: number): string {
	const parts = segmentLines(text);
	const end = skip === 0 ? parts.length : Math.max(0, parts.length - skip);
	const selected = parts.slice(Math.max(0, end - lines), end);
	return selected.length === 0 ? "" : `${selected.join("\n")}\n`;
}

async function readRecordingManifest(path: string): Promise<PaneRecordingManifest> {
	const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
	if (!isRecordingManifest(parsed)) throw new Error(`invalid pane recording manifest: ${path}`);
	return parsed;
}

function isRecordingManifest(value: unknown): value is PaneRecordingManifest {
	if (typeof value !== "object" || value === null) return false;
	const rec = value as Record<string, unknown>;
	return (
		rec.version === 1 &&
		rec.kind === "pane-recording" &&
		typeof rec.session === "string" &&
		typeof rec.recordingId === "string" &&
		typeof rec.paneId === "string" &&
		typeof rec.startedAt === "string"
	);
}

// ---------------------------------------------------------------------------
// Recorder service
// ---------------------------------------------------------------------------

export interface PaneRecorderOptions {
	env?: NodeJS.ProcessEnv;
	/** Record wrapper-covered panes' bytes too (CLANKY_PANE_RECORDER_RECORD_ALL=1). */
	recordAll?: boolean;
	/** Seed-only one-shot: seed every live pane, then stop (no streams, no lock). */
	seedOnly?: boolean;
	log?: (message: string) => void;
}

export interface PaneRecorderStatus {
	running: boolean;
	session: string;
	attachSupported: boolean | undefined;
	activePanes: { paneId: string; recordingId: string; streaming: boolean; coveredBy?: string }[];
	startedAt: string;
	lastError?: string;
}

export interface PaneRecorderHandle {
	stop(): Promise<void>;
	status(): PaneRecorderStatus;
}

interface ActiveCapture {
	paneId: string;
	recording: PaneRecording;
	stream?: HerdrStream;
	streaming: boolean;
	closed: boolean;
	backoffMs: number;
	epoch: number;
	lastSeq?: number;
	retryTimer?: NodeJS.Timeout;
}

interface RecorderLockRecord {
	pid: number;
	startedAt: string;
	heartbeatAt: string;
}

function isAttachUnsupportedError(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error);
	return message.includes("unknown variant `pane.attach`") || message.includes("unknown variant 'pane.attach'");
}

function paneInfoFromEventData(data: Record<string, unknown>): PaneInfoLike | undefined {
	const pane = data.pane;
	if (typeof pane === "object" && pane !== null && typeof (pane as { pane_id?: unknown }).pane_id === "string") {
		return pane as unknown as PaneInfoLike;
	}
	if (typeof data.pane_id === "string") return { pane_id: data.pane_id };
	return undefined;
}

/**
 * Detect the in-path worker-transcript wrapper so its panes are not
 * byte-recorded twice. Best-effort: an unreadable process table records the
 * pane normally.
 */
async function paneIsWrapperCovered(paneId: string): Promise<boolean> {
	try {
		const info = (await herdrRequest("pane.process_info", { pane_id: paneId })) as {
			process_info?: { foreground_processes?: { cmdline?: string; argv?: string[] }[] };
			foreground_processes?: { cmdline?: string; argv?: string[] }[];
		};
		const processes = info.process_info?.foreground_processes ?? info.foreground_processes ?? [];
		return processes.some((process) => {
			const cmdline = process.cmdline ?? process.argv?.join(" ") ?? "";
			return cmdline.includes("transcript-run") || cmdline.includes("transcript-exec");
		});
	} catch {
		return false;
	}
}

export async function startPaneRecorder(options: PaneRecorderOptions = {}): Promise<PaneRecorderHandle | undefined> {
	const env = options.env ?? process.env;
	const log = options.log ?? ((message: string) => console.error(message));
	const session = resolveTranscriptSession(env);
	const root = resolvePaneRecordingsRoot(env);
	await mkdir(root, { recursive: true });

	if (options.seedOnly !== true) {
		const acquired = await acquireRecorderLock(root);
		if (!acquired) {
			log(`pane recorder: another recorder holds the ${session} session lock; not starting`);
			return undefined;
		}
	}

	const captures = new Map<string, ActiveCapture>();
	const startedAt = new Date().toISOString();
	let attachSupported: boolean | undefined;
	let lastError: string | undefined;
	let stopped = false;
	let eventsStream: HerdrStream | undefined;
	let eventsRetryTimer: NodeJS.Timeout | undefined;
	let eventsBackoffMs = EVENTS_RECONNECT_MIN_MS;
	let heartbeatTimer: NodeJS.Timeout | undefined;

	const finalizeCapture = async (capture: ActiveCapture, reason: string): Promise<void> => {
		if (capture.closed) return;
		capture.closed = true;
		if (capture.retryTimer !== undefined) clearTimeout(capture.retryTimer);
		capture.stream?.close();
		captures.delete(capture.paneId);
		await capture.recording.writeChain.catch(() => undefined);
		await finalizePaneRecording(capture.recording, reason).catch(() => undefined);
	};

	const seedCapture = async (capture: ActiveCapture, reason: string): Promise<void> => {
		try {
			const result = (await herdrRequest("pane.read", {
				pane_id: capture.paneId,
				source: "recent_unwrapped",
				lines: SEED_LINES,
			})) as { read?: { text?: string }; text?: string };
			const text = result.read?.text ?? result.text ?? "";
			if (text.length > 0) await writeRecordingSeed(capture.recording, text, reason);
		} catch (error) {
			await appendRecordingEvent(capture.recording, {
				event: "error",
				during: "seed",
				message: (error as Error).message,
			}).catch(() => undefined);
		}
	};

	const attachEpoch = (capture: ActiveCapture): void => {
		if (stopped || capture.closed || attachSupported === false) return;
		capture.epoch += 1;
		let acked = false;
		capture.stream = herdrStreamLines(
			{
				id: `recorder_${capture.paneId}_${capture.epoch}`,
				method: "pane.attach",
				params: { pane_id: capture.paneId },
			},
			(line) => {
				if (stopped || capture.closed) return;
				let envelope: Record<string, unknown>;
				try {
					envelope = JSON.parse(line) as Record<string, unknown>;
				} catch {
					return;
				}
				if (!acked) {
					const error = envelope.error as { message?: string; code?: string } | undefined;
					if (error !== undefined) {
						capture.stream?.close();
						capture.streaming = false;
						const message = error.message ?? error.code ?? "pane.attach failed";
						if (isAttachUnsupportedError(new Error(message))) {
							attachSupported = false;
							log("pane recorder: herdr lacks pane.attach; running in seed-only degraded mode");
							void appendRecordingEvent(capture.recording, { event: "attach-unsupported" });
							return;
						}
						void appendRecordingEvent(capture.recording, {
							event: "error",
							during: "attach",
							message,
						});
						scheduleReattach(capture, message);
						return;
					}
					const result = envelope.result as { type?: string } | undefined;
					if (result?.type === "pane_attached") {
						acked = true;
						attachSupported = true;
						capture.streaming = true;
						capture.backoffMs = ATTACH_BACKOFF_MIN_MS;
						void appendRecordingEvent(capture.recording, { event: "attach", epoch: capture.epoch });
						void seedCapture(capture, capture.epoch === 1 ? "attach" : "reattach");
					}
					return;
				}
				if (envelope.stream !== true) return;
				const chunk = envelope.chunk as
					| { pane_id?: string; seq?: number; encoding?: string; data?: string }
					| undefined;
				if (chunk?.encoding !== "base64" || typeof chunk.data !== "string") return;
				if (typeof chunk.seq === "number") {
					if (capture.lastSeq !== undefined && chunk.seq > capture.lastSeq + 1) {
						void appendRecordingEvent(capture.recording, {
							event: "stream-gap",
							expected: capture.lastSeq + 1,
							got: chunk.seq,
						});
					}
					capture.lastSeq = chunk.seq;
				}
				void appendRecordingChunk(capture.recording, Buffer.from(chunk.data, "base64")).catch((error) => {
					lastError = `append failed: ${(error as Error).message}`;
				});
			},
			(error) => {
				if (stopped || capture.closed) return;
				capture.streaming = false;
				scheduleReattach(capture, error.message);
			},
			() => {
				if (stopped || capture.closed) return;
				capture.streaming = false;
				scheduleReattach(capture, acked ? "stream closed" : "closed before acknowledgement");
			},
		);
	};

	const scheduleReattach = (capture: ActiveCapture, reason: string): void => {
		if (stopped || capture.closed || attachSupported === false) return;
		void appendRecordingEvent(capture.recording, { event: "stream-gap", reason });
		capture.lastSeq = undefined;
		const delay = capture.backoffMs;
		capture.backoffMs = Math.min(ATTACH_BACKOFF_MAX_MS, capture.backoffMs * 2);
		capture.retryTimer = setTimeout(() => {
			if (stopped || capture.closed) return;
			// The pane may have closed while we backed off; probe before attaching.
			herdrRequest("pane.get", { pane_id: capture.paneId })
				.then(() => attachEpoch(capture))
				.catch(() => void finalizeCapture(capture, "pane gone during reattach"));
		}, delay);
	};

	const startCapture = async (pane: PaneInfoLike): Promise<void> => {
		if (stopped || captures.has(pane.pane_id)) return;
		const covered = options.recordAll === true ? false : await paneIsWrapperCovered(pane.pane_id);
		// Reuse an un-ended recording for the same terminal (brain restart while
		// the pane lived on); terminal ids are unique so pane-id reuse is safe.
		let recording: PaneRecording | undefined;
		if (pane.terminal_id !== undefined) {
			const existing = (await listPaneRecordings(env)).find(
				(summary) => summary.endedAt === undefined && summary.terminalId === pane.terminal_id,
			);
			if (existing !== undefined) {
				recording = await openPaneRecording(existing.path).catch(() => undefined);
				if (recording !== undefined) {
					await appendRecordingEvent(recording, { event: "resumed", paneId: pane.pane_id });
				}
			}
		}
		if (recording === undefined) {
			recording = await createPaneRecording(pane, {
				env,
				...(covered ? { coveredBy: "worker-transcript" as const } : {}),
			});
		}
		const capture: ActiveCapture = {
			paneId: pane.pane_id,
			recording,
			streaming: false,
			closed: false,
			backoffMs: ATTACH_BACKOFF_MIN_MS,
			epoch: 0,
		};
		captures.set(pane.pane_id, capture);
		if (covered) {
			await appendRecordingEvent(recording, { event: "skip-wrapped" });
			return;
		}
		if (options.seedOnly === true || attachSupported === false) {
			await seedCapture(capture, options.seedOnly === true ? "seed-only" : "degraded");
			return;
		}
		attachEpoch(capture);
	};

	const handleEventLine = (line: string): void => {
		if (stopped) return;
		let envelope: Record<string, unknown>;
		try {
			envelope = JSON.parse(line) as Record<string, unknown>;
		} catch {
			return;
		}
		const kind = envelope.event;
		const data = (envelope.data ?? {}) as Record<string, unknown>;
		if (kind === "pane_created") {
			const pane = paneInfoFromEventData(data);
			if (pane !== undefined) void startCapture(pane);
			return;
		}
		if (kind === "pane_closed" || kind === "pane_exited") {
			const paneId = typeof data.pane_id === "string" ? data.pane_id : undefined;
			if (paneId === undefined) return;
			const capture = captures.get(paneId);
			if (capture !== undefined) void finalizeCapture(capture, String(kind));
		}
	};

	const subscribeEvents = (): void => {
		if (stopped || options.seedOnly === true) return;
		eventsStream = herdrStreamLines(
			{
				id: `recorder_events_${Date.now().toString(36)}`,
				method: "events.subscribe",
				params: {
					subscriptions: [{ type: "pane.created" }, { type: "pane.closed" }, { type: "pane.exited" }],
				},
			},
			(line) => {
				eventsBackoffMs = EVENTS_RECONNECT_MIN_MS;
				handleEventLine(line);
			},
			(error) => scheduleEventsReconnect(`events stream error: ${error.message}`),
			() => scheduleEventsReconnect("events stream closed"),
		);
	};

	const scheduleEventsReconnect = (reason: string): void => {
		if (stopped) return;
		lastError = reason;
		const delay = eventsBackoffMs;
		eventsBackoffMs = Math.min(EVENTS_RECONNECT_MAX_MS, eventsBackoffMs * 2);
		eventsRetryTimer = setTimeout(() => {
			if (stopped) return;
			subscribeEvents();
			void reconcilePanes();
		}, delay);
	};

	const reconcilePanes = async (): Promise<void> => {
		let panes: PaneInfoLike[];
		try {
			const result = (await herdrRequest("pane.list", {})) as { panes?: PaneInfoLike[] };
			panes = result.panes ?? [];
		} catch (error) {
			lastError = `pane.list failed: ${(error as Error).message}`;
			return;
		}
		const livePaneIds = new Set(panes.map((pane) => pane.pane_id));
		const liveTerminalIds = new Set(panes.map((pane) => pane.terminal_id).filter((id) => id !== undefined));
		await Promise.all(panes.map((pane) => startCapture(pane)));
		// Finalize open recordings that no live terminal backs — the pane
		// vanished while no recorder watched, or a herdr handoff reissued
		// terminal ids and a fresh recording took over the pane.
		const activeRecordingIds = new Set(
			[...captures.values()].map((capture) => capture.recording.manifest.recordingId),
		);
		for (const summary of await listPaneRecordings(env).catch(() => [] as PaneRecordingSummary[])) {
			if (summary.endedAt !== undefined) continue;
			if (activeRecordingIds.has(summary.recordingId)) continue;
			if (summary.terminalId !== undefined && liveTerminalIds.has(summary.terminalId)) continue;
			if (summary.terminalId === undefined && livePaneIds.has(summary.paneId)) continue;
			const recording = await openPaneRecording(summary.path).catch(() => undefined);
			if (recording !== undefined) await finalizePaneRecording(recording, "orphaned").catch(() => undefined);
		}
	};

	if (options.seedOnly !== true) {
		heartbeatTimer = setInterval(() => {
			void writeRecorderLock(root);
		}, LOCK_HEARTBEAT_MS);
		heartbeatTimer.unref?.();
		subscribeEvents();
	}
	await reconcilePanes();

	if (options.seedOnly === true) {
		// Seeds flushed; captures hold no streams in seed-only mode.
		for (const capture of captures.values()) {
			await capture.recording.writeChain.catch(() => undefined);
		}
		return {
			stop: async () => undefined,
			status: () => ({
				running: false,
				session,
				attachSupported,
				activePanes: [],
				startedAt,
				...(lastError === undefined ? {} : { lastError }),
			}),
		};
	}

	log(`pane recorder: recording session ${session} (${captures.size} pane(s))`);

	return {
		stop: async () => {
			stopped = true;
			if (eventsRetryTimer !== undefined) clearTimeout(eventsRetryTimer);
			if (heartbeatTimer !== undefined) clearInterval(heartbeatTimer);
			eventsStream?.close();
			for (const capture of captures.values()) {
				if (capture.retryTimer !== undefined) clearTimeout(capture.retryTimer);
				capture.stream?.close();
				// Do not finalize: the pane outlives the brain; the next recorder
				// resumes this recording by terminal id.
				await capture.recording.writeChain.catch(() => undefined);
				await appendRecordingEvent(capture.recording, { event: "recorder-stopped" }).catch(() => undefined);
			}
			captures.clear();
			await rm(join(root, LOCK_FILE), { force: true }).catch(() => undefined);
		},
		status: () => ({
			running: !stopped,
			session,
			attachSupported,
			activePanes: [...captures.values()].map((capture) => ({
				paneId: capture.paneId,
				recordingId: capture.recording.manifest.recordingId,
				streaming: capture.streaming,
				...(capture.recording.manifest.coveredBy === undefined
					? {}
					: { coveredBy: capture.recording.manifest.coveredBy }),
			})),
			startedAt,
			...(lastError === undefined ? {} : { lastError }),
		}),
	};
}

async function acquireRecorderLock(root: string): Promise<boolean> {
	const path = join(root, LOCK_FILE);
	const existing = await readFile(path, "utf8")
		.then((raw) => JSON.parse(raw) as RecorderLockRecord)
		.catch(() => undefined);
	if (existing !== undefined) {
		const age = Date.now() - Date.parse(existing.heartbeatAt);
		if (Number.isFinite(age) && age < LOCK_STALE_MS && existing.pid !== process.pid && pidAlive(existing.pid)) {
			return false;
		}
	}
	await writeRecorderLock(root);
	return true;
}

async function writeRecorderLock(root: string): Promise<void> {
	const record: RecorderLockRecord = {
		pid: process.pid,
		startedAt: new Date().toISOString(),
		heartbeatAt: new Date().toISOString(),
	};
	await writeFile(join(root, LOCK_FILE), `${JSON.stringify(record)}\n`).catch(() => undefined);
}

function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}
