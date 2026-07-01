import { randomUUID } from "node:crypto";
import { appendFile, mkdir, open, readFile, readdir, rm, rmdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { resolveClankyDataPath } from "./paths.ts";

export const TRANSCRIPT_SOURCE = "clanky-transcript" as const;

const TRANSCRIPTS_DATA_DIR = "herdr-transcripts";

export interface TranscriptManifest {
	version: 1;
	session: string;
	agent: string;
	runId: string;
	cwd: string;
	argv: string[];
	startedAt: string;
	endedAt?: string;
	exitCode?: number | null;
	signal?: string | null;
}

export interface TranscriptRun {
	dir: string;
	manifestPath: string;
	ansiPath: string;
	textPath: string;
	manifest: TranscriptManifest;
	/** Bytes withheld from stream.txt because an escape sequence spans chunks. */
	pending: { stdout: string; stderr: string };
}

export interface TranscriptSummary {
	session: string;
	agent: string;
	runId: string;
	startedAt: string;
	endedAt?: string;
	cwd: string;
	path: string;
}

export interface TranscriptRead {
	source: typeof TRANSCRIPT_SOURCE;
	fallback: false;
	session: string;
	agent: string;
	runId: string;
	path: string;
	lines: number;
	text: string;
}

export type TranscriptStream = "stdout" | "stderr";

export function resolveTranscriptSession(env: NodeJS.ProcessEnv = process.env): string {
	const session = env.HERDR_SESSION?.trim();
	return session === undefined || session.length === 0 ? "default" : session;
}

export function resolveTranscriptRoot(env: NodeJS.ProcessEnv = process.env): string {
	return resolveClankyDataPath(join(TRANSCRIPTS_DATA_DIR, transcriptPathSegment(resolveTranscriptSession(env), "session")), env);
}

export function newTranscriptRunId(now = new Date()): string {
	const stamp = now.toISOString().replace(/[-:.TZ]/g, "");
	return `${stamp}-${randomUUID().slice(0, 8)}`;
}

export function resolveTranscriptRunPath(input: {
	agent: string;
	runId: string;
	env?: NodeJS.ProcessEnv;
}): string {
	return join(resolveTranscriptRoot(input.env), transcriptPathSegment(input.agent, "agent"), transcriptPathSegment(input.runId, "run id"));
}

export async function createTranscriptRun(input: {
	agent: string;
	cwd: string;
	argv: readonly string[];
	runId?: string;
	env?: NodeJS.ProcessEnv;
	now?: Date;
}): Promise<TranscriptRun> {
	const session = resolveTranscriptSession(input.env);
	const runId = input.runId ?? newTranscriptRunId(input.now);
	const dir = resolveTranscriptRunPath({ agent: input.agent, runId, env: input.env });
	const manifest: TranscriptManifest = {
		version: 1,
		session,
		agent: input.agent,
		runId,
		cwd: input.cwd,
		argv: [...input.argv],
		startedAt: (input.now ?? new Date()).toISOString(),
	};
	const run = transcriptRunFromManifest(dir, manifest);
	await mkdir(dir, { recursive: true });
	await Promise.all([
		writeFile(run.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`),
		writeFile(run.ansiPath, ""),
		writeFile(run.textPath, ""),
	]);
	await maybeSweepTranscriptRetention(input.env);
	return run;
}

export async function appendTranscriptChunk(
	run: TranscriptRun,
	stream: TranscriptStream,
	chunk: Buffer | Uint8Array,
): Promise<void> {
	const buffer = Buffer.from(chunk);
	// Escape sequences can split across chunks; normalize only the portion that
	// cannot still be growing and carry the rest into the next append. stream.ansi
	// stays the lossless raw record; stream.txt is the normalized readable one.
	const combined = run.pending[stream] + buffer.toString("utf8");
	const { done, pending } = splitPendingEscape(combined);
	run.pending[stream] = pending;
	const text = normalizeTerminalText(done);
	await appendFile(run.ansiPath, buffer);
	if (text.length > 0) await appendFile(run.textPath, text);
}

export async function finishTranscriptRun(
	run: TranscriptRun,
	result: { exitCode: number | null; signal: string | null; now?: Date },
): Promise<TranscriptRun> {
	const manifest = {
		...run.manifest,
		endedAt: (result.now ?? new Date()).toISOString(),
		exitCode: result.exitCode,
		signal: result.signal,
	};
	const updated = transcriptRunFromManifest(run.dir, manifest);
	await writeFile(updated.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
	return updated;
}

export async function listTranscriptRuns(env: NodeJS.ProcessEnv = process.env): Promise<TranscriptSummary[]> {
	const root = resolveTranscriptRoot(env);
	const agents = await readdir(root, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
		if (error.code === "ENOENT") return [];
		throw error;
	});
	const summaries: TranscriptSummary[] = [];
	for (const agentDir of agents) {
		if (!agentDir.isDirectory()) continue;
		// "panes" is reserved for the session-wide pane recorder (ADR-0007);
		// its recording dirs are not worker runs.
		if (agentDir.name === "panes") continue;
		const agentPath = join(root, agentDir.name);
		const runs = await readdir(agentPath, { withFileTypes: true }).catch(() => []);
		for (const runDir of runs) {
			if (!runDir.isDirectory()) continue;
			const dir = join(agentPath, runDir.name);
			const manifest = await readManifest(join(dir, "manifest.json")).catch(() => undefined);
			if (manifest === undefined) continue;
			summaries.push({
				session: manifest.session,
				agent: manifest.agent,
				runId: manifest.runId,
				startedAt: manifest.startedAt,
				endedAt: manifest.endedAt,
				cwd: manifest.cwd,
				path: dir,
			});
		}
	}
	return summaries.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

export async function latestTranscriptRun(
	agent: string,
	options: { runId?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<TranscriptRun> {
	const root = resolveTranscriptRoot(options.env);
	const agentPath = join(root, transcriptPathSegment(agent, "agent"));
	if (options.runId !== undefined) {
		const dir = join(agentPath, transcriptPathSegment(options.runId, "run id"));
		const manifest = await readManifest(join(dir, "manifest.json"));
		return transcriptRunFromManifest(dir, manifest);
	}
	const entries = await readdir(agentPath, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
		if (error.code === "ENOENT") return [];
		throw error;
	});
	const runs = await Promise.all(
		entries
			.filter((entry) => entry.isDirectory())
			.map(async (entry) => {
				const dir = join(agentPath, entry.name);
				const manifest = await readManifest(join(dir, "manifest.json")).catch(() => undefined);
				return manifest === undefined ? undefined : transcriptRunFromManifest(dir, manifest);
			}),
	);
	const found = runs
		.filter((run): run is TranscriptRun => run !== undefined)
		.sort((a, b) => b.manifest.startedAt.localeCompare(a.manifest.startedAt))[0];
	if (found === undefined) throw new Error(`no Clanky transcript found for ${agent}`);
	return found;
}

// Tail reads only need the last `lines` lines, so bound how much of the
// (potentially very large) stream.txt is loaded per read. The per-line byte
// allowance is generous; pathological single lines degrade to a partial tail
// rather than an unbounded read.
const READ_TAIL_BYTES_PER_LINE = 2048;
const READ_TAIL_MIN_BYTES = 64 * 1024;
const READ_TAIL_MAX_BYTES = 4 * 1024 * 1024;

export async function readTranscript(
	agent: string,
	options: { lines?: number; runId?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<TranscriptRead> {
	const lines = options.lines ?? 120;
	if (!Number.isInteger(lines) || lines < 1) throw new Error(`lines must be a positive integer; got ${lines}`);
	const run = await latestTranscriptRun(agent, { runId: options.runId, env: options.env });
	const windowBytes = Math.min(READ_TAIL_MAX_BYTES, Math.max(READ_TAIL_MIN_BYTES, lines * READ_TAIL_BYTES_PER_LINE));
	const text = await readFileTail(run.textPath, windowBytes);
	return {
		source: TRANSCRIPT_SOURCE,
		fallback: false,
		session: run.manifest.session,
		agent: run.manifest.agent,
		runId: run.manifest.runId,
		path: run.dir,
		lines,
		text: lastLines(text, lines),
	};
}

/** Read at most the last `maxBytes` of a file; missing file reads as empty. */
async function readFileTail(path: string, maxBytes: number): Promise<string> {
	const handle = await open(path, "r").catch((error: NodeJS.ErrnoException) => {
		if (error.code === "ENOENT") return undefined;
		throw error;
	});
	if (handle === undefined) return "";
	try {
		const size = (await handle.stat()).size;
		const length = Math.min(size, maxBytes);
		if (length === 0) return "";
		const buffer = Buffer.alloc(length);
		const { bytesRead } = await handle.read(buffer, 0, length, size - length);
		let text = buffer.toString("utf8", 0, bytesRead);
		// A mid-file window can open inside a line (or a multi-byte character);
		// drop that partial first line when complete lines follow it.
		if (size > length) {
			const newline = text.indexOf("\n");
			if (newline !== -1) text = text.slice(newline + 1);
		}
		return text;
	} finally {
		await handle.close();
	}
}

export function lastLines(text: string, lines: number): string {
	if (!Number.isInteger(lines) || lines < 1) throw new Error(`lines must be a positive integer; got ${lines}`);
	const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
	const hadFinalNewline = normalized.endsWith("\n");
	const parts = hadFinalNewline ? normalized.slice(0, -1).split("\n") : normalized.split("\n");
	const selected = parts.slice(Math.max(0, parts.length - lines)).join("\n");
	if (selected.length === 0) return "";
	return hadFinalNewline ? `${selected}\n` : selected;
}

/**
 * Split a buffer into the part safe to normalize now (`done`) and a trailing
 * incomplete escape sequence to carry into the next chunk (`pending`). `pending`
 * always begins at an ESC; it is empty unless the buffer ends mid-sequence.
 */
export function splitPendingEscape(buf: string): { done: string; pending: string } {
	const len = buf.length;
	let i = 0;
	while (i < len) {
		if (buf[i] !== "\x1B") {
			i++;
			continue;
		}
		const end = consumeEscape(buf, i);
		if (end === -1) {
			const rest = buf.slice(i);
			// A real control sequence is short; a long unterminated run is almost
			// certainly stray bytes, so stop carrying and let normalize best-effort it.
			if (rest.length > 256) return { done: buf, pending: "" };
			return { done: buf.slice(0, i), pending: rest };
		}
		i = end;
	}
	return { done: buf, pending: "" };
}

/** Index after a complete escape sequence starting at `start`, or -1 if incomplete. */
function consumeEscape(buf: string, start: number): number {
	const len = buf.length;
	if (start + 1 >= len) return -1;
	const c = buf[start + 1];
	if (c === "[") {
		let j = start + 2;
		while (j < len && buf[j] >= "0" && buf[j] <= "?") j++;
		while (j < len && buf[j] >= " " && buf[j] <= "/") j++;
		if (j < len && buf[j] >= "@" && buf[j] <= "~") return j + 1;
		return -1;
	}
	if (c === "]") {
		for (let j = start + 2; j < len; j++) {
			if (buf[j] === "\x07") return j + 1;
			if (buf[j] === "\x1B") {
				if (j + 1 >= len) return -1;
				if (buf[j + 1] === "\\") return j + 2;
			}
		}
		return -1;
	}
	if (c === "P" || c === "^" || c === "_" || c === "X") {
		for (let j = start + 2; j < len; j++) {
			if (buf[j] === "\x1B") {
				if (j + 1 >= len) return -1;
				if (buf[j + 1] === "\\") return j + 2;
			}
		}
		return -1;
	}
	return start + 2;
}

export function normalizeTerminalText(input: string): string {
	const withoutEscapes = input
		.replace(/\x1B\][^\x07]*(?:\x07|\x1B\\)/g, "")
		.replace(/\x1B[P^_][\s\S]*?\x1B\\/g, "")
		.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "")
		.replace(/\x1B[@-Z\\-_]/g, "");
	const chars: string[] = [];
	for (const char of withoutEscapes.replace(/\r\n/g, "\n").replace(/\r/g, "\n")) {
		if (char === "\b") {
			chars.pop();
			continue;
		}
		if (/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/.test(char)) continue;
		chars.push(char);
	}
	return chars.join("");
}

async function readManifest(path: string): Promise<TranscriptManifest> {
	const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
	if (!isManifest(parsed)) throw new Error(`invalid transcript manifest: ${path}`);
	return parsed;
}

function transcriptRunFromManifest(dir: string, manifest: TranscriptManifest): TranscriptRun {
	return {
		dir,
		manifestPath: join(dir, "manifest.json"),
		ansiPath: join(dir, "stream.ansi"),
		textPath: join(dir, "stream.txt"),
		manifest,
		pending: { stdout: "", stderr: "" },
	};
}

function isManifest(value: unknown): value is TranscriptManifest {
	if (typeof value !== "object" || value === null) return false;
	const rec = value as Record<string, unknown>;
	return (
		rec.version === 1 &&
		typeof rec.session === "string" &&
		typeof rec.agent === "string" &&
		typeof rec.runId === "string" &&
		typeof rec.cwd === "string" &&
		Array.isArray(rec.argv) &&
		rec.argv.every((item) => typeof item === "string") &&
		typeof rec.startedAt === "string"
	);
}

/** Sanitized path segment for transcript-store dir names (pane recorder shares the scheme). */
export function transcriptPathSegment(value: string, label: string): string {
	const trimmed = value.trim();
	if (trimmed.length === 0) throw new Error(`transcript ${label} must not be empty`);
	const segment = trimmed.replace(/[^A-Za-z0-9._:-]+/g, "_");
	if (segment === "." || segment === ".." || segment.length === 0) {
		throw new Error(`invalid transcript ${label}: ${value}`);
	}
	return segment;
}

export interface TranscriptRetentionBudget {
	/** Runs with activity newer than this are always kept (live-run guard). */
	minAgeMs: number;
	/** Runs idle longer than this are deleted regardless of the other budgets. */
	maxAgeMs: number;
	/** Newest-first cap on stored runs across all sessions. */
	maxRuns: number;
	/** Newest-first cap on total stored bytes across all sessions. */
	maxTotalBytes: number;
}

/** Conservative defaults: 30 days, 500 runs, 2 GiB across every session. */
export const TRANSCRIPT_RETENTION: TranscriptRetentionBudget = {
	minAgeMs: 6 * 60 * 60 * 1000,
	maxAgeMs: 30 * 24 * 60 * 60 * 1000,
	maxRuns: 500,
	maxTotalBytes: 2 * 1024 * 1024 * 1024,
};

const RETENTION_SWEEP_INTERVAL_MS = 60 * 60 * 1000;
const RETENTION_SWEEP_MARKER = ".retention-sweep";

interface TranscriptRunUsage {
	dir: string;
	bytes: number;
	/** Newest file mtime in the run dir, so live runs keep counting as active. */
	lastActiveAt: number;
}

/**
 * Enforce the retention budget across every stored transcript run (all
 * sessions). Runs are ranked newest-activity first; a run is deleted once it
 * is idle past `maxAgeMs` or falls outside the run/byte budgets, but never
 * while its newest file is younger than `minAgeMs` (an in-flight capture keeps
 * appending, so a live run always looks recent). Returns deleted run count.
 */
export async function sweepTranscriptRetention(
	env: NodeJS.ProcessEnv = process.env,
	budget: TranscriptRetentionBudget = TRANSCRIPT_RETENTION,
	now = Date.now(),
): Promise<number> {
	const base = resolveClankyDataPath(TRANSCRIPTS_DATA_DIR, env);
	const runs: TranscriptRunUsage[] = [];
	for (const sessionName of await listDirectories(base)) {
		const sessionPath = join(base, sessionName);
		for (const agentName of await listDirectories(sessionPath)) {
			const agentPath = join(sessionPath, agentName);
			for (const runName of await listDirectories(agentPath)) {
				const usage = await measureRunDir(join(agentPath, runName));
				if (usage !== undefined) runs.push(usage);
			}
		}
	}
	runs.sort((left, right) => right.lastActiveAt - left.lastActiveAt);
	let keptRuns = 0;
	let keptBytes = 0;
	let deleted = 0;
	for (const run of runs) {
		const idleMs = now - run.lastActiveAt;
		if (idleMs > budget.minAgeMs) {
			const overBudget = keptRuns >= budget.maxRuns || keptBytes + run.bytes > budget.maxTotalBytes;
			if (idleMs > budget.maxAgeMs || overBudget) {
				await rm(run.dir, { recursive: true, force: true });
				deleted += 1;
				continue;
			}
		}
		keptRuns += 1;
		keptBytes += run.bytes;
	}
	if (deleted > 0) await pruneEmptyTranscriptDirs(base);
	return deleted;
}

/**
 * Opportunistic, throttled retention: runs at most once per sweep interval,
 * keyed off a marker file's mtime so concurrent short-lived transcript-run
 * processes share the throttle. Best-effort by design.
 */
async function maybeSweepTranscriptRetention(env: NodeJS.ProcessEnv | undefined): Promise<void> {
	try {
		const marker = resolveClankyDataPath(join(TRANSCRIPTS_DATA_DIR, RETENTION_SWEEP_MARKER), env);
		const info = await stat(marker).catch(() => undefined);
		const now = Date.now();
		if (info !== undefined && now - info.mtimeMs < RETENTION_SWEEP_INTERVAL_MS) return;
		await writeFile(marker, `${new Date(now).toISOString()}\n`);
		await sweepTranscriptRetention(env, TRANSCRIPT_RETENTION, now);
	} catch {
		// Retention must never block creating a new transcript run.
	}
}

async function listDirectories(path: string): Promise<string[]> {
	const entries = await readdir(path, { withFileTypes: true }).catch(() => []);
	return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
}

async function measureRunDir(dir: string): Promise<TranscriptRunUsage | undefined> {
	const entries = await readdir(dir, { withFileTypes: true }).catch(() => undefined);
	if (entries === undefined) return undefined;
	let bytes = 0;
	let lastActiveAt = 0;
	for (const entry of entries) {
		if (!entry.isFile()) continue;
		const info = await stat(join(dir, entry.name)).catch(() => undefined);
		if (info === undefined) continue;
		bytes += info.size;
		lastActiveAt = Math.max(lastActiveAt, info.mtimeMs);
	}
	if (lastActiveAt === 0) {
		const info = await stat(dir).catch(() => undefined);
		if (info === undefined) return undefined;
		lastActiveAt = info.mtimeMs;
	}
	return { dir, bytes, lastActiveAt };
}

/** Drop agent/session dirs a sweep emptied; rmdir refuses non-empty dirs. */
async function pruneEmptyTranscriptDirs(base: string): Promise<void> {
	for (const sessionName of await listDirectories(base)) {
		const sessionPath = join(base, sessionName);
		for (const agentName of await listDirectories(sessionPath)) {
			await rmdir(join(sessionPath, agentName)).catch(() => undefined);
		}
		await rmdir(sessionPath).catch(() => undefined);
	}
}
