import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { resolveClankyDataPath } from "./paths.ts";

export const TRANSCRIPT_SOURCE = "clanky-transcript" as const;

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
	eventsPath: string;
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
	return resolveClankyDataPath(join("herdr-transcripts", pathSegment(resolveTranscriptSession(env), "session")), env);
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
	return join(resolveTranscriptRoot(input.env), pathSegment(input.agent, "agent"), pathSegment(input.runId, "run id"));
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
		writeFile(run.eventsPath, ""),
	]);
	return run;
}

export async function appendTranscriptChunk(
	run: TranscriptRun,
	stream: TranscriptStream,
	chunk: Buffer | Uint8Array,
	now = new Date(),
): Promise<void> {
	const buffer = Buffer.from(chunk);
	// Escape sequences can split across chunks; normalize only the portion that
	// cannot still be growing and carry the rest into the next append. stream.ansi
	// stays the lossless raw record.
	const combined = run.pending[stream] + buffer.toString("utf8");
	const { done, pending } = splitPendingEscape(combined);
	run.pending[stream] = pending;
	const text = normalizeTerminalText(done);
	const event = {
		ts: now.toISOString(),
		stream,
		bytes: buffer.byteLength,
		text,
	};
	await appendFile(run.ansiPath, buffer);
	if (text.length > 0) await appendFile(run.textPath, text);
	await appendFile(run.eventsPath, `${JSON.stringify(event)}\n`);
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
	const agentPath = join(root, pathSegment(agent, "agent"));
	if (options.runId !== undefined) {
		const dir = join(agentPath, pathSegment(options.runId, "run id"));
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

export async function readTranscript(
	agent: string,
	options: { lines?: number; runId?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<TranscriptRead> {
	const lines = options.lines ?? 120;
	if (!Number.isInteger(lines) || lines < 1) throw new Error(`lines must be a positive integer; got ${lines}`);
	const run = await latestTranscriptRun(agent, { runId: options.runId, env: options.env });
	const text = await readFile(run.textPath, "utf8").catch((error: NodeJS.ErrnoException) => {
		if (error.code === "ENOENT") return "";
		throw error;
	});
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
		eventsPath: join(dir, "events.jsonl"),
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

function pathSegment(value: string, label: string): string {
	const trimmed = value.trim();
	if (trimmed.length === 0) throw new Error(`transcript ${label} must not be empty`);
	const segment = trimmed.replace(/[^A-Za-z0-9._:-]+/g, "_");
	if (segment === "." || segment === ".." || segment.length === 0) {
		throw new Error(`invalid transcript ${label}: ${value}`);
	}
	return segment;
}
