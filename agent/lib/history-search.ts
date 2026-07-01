/**
 * Full-text search across the herdr history store (SPEC.md §4.3, ADR-0007):
 * worker transcripts and session-wide pane recordings, active text plus
 * gzipped archives. Uses ripgrep (`rg --json --search-zip`) when installed;
 * falls back to a bounded pure-node scan otherwise. No index is kept — the
 * store is capped at the transcript retention budget, which rg handles in
 * seconds. Revisit incremental indexing only if budgets grow.
 */
import { execFile } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { promisify } from "node:util";
import { gunzip } from "node:zlib";
import { PANE_RECORDINGS_DIR, listPaneRecordings, type PaneRecordingSummary } from "./pane-recorder.ts";
import { resolveTranscriptRoot } from "./transcripts.ts";

const execFileAsync = promisify(execFile);
const gunzipAsync = promisify(gunzip);

const MATCH_LINE_MAX_CHARS = 500;
const RG_MAX_BUFFER_BYTES = 32 * 1024 * 1024;
/** Fallback-scan ceiling so a missing rg never turns into an unbounded read. */
const SCAN_MAX_BYTES = 256 * 1024 * 1024;

export interface HistorySearchMatch {
	kind: "worker" | "pane";
	/** Worker agent name, or the recorded pane's detected agent when known. */
	agent?: string;
	paneId?: string;
	label?: string;
	/** Worker run id or pane recording id. */
	id: string;
	/** File within the run/recording dir (stream.txt, archive-000001.txt.gz, seed-000001.txt). */
	file: string;
	lineNumber: number;
	line: string;
}

export interface HistorySearchResult {
	query: string;
	root: string;
	engine: "ripgrep" | "scan";
	matches: HistorySearchMatch[];
	/** True when the match limit cut results off. */
	truncated: boolean;
}

export async function searchHerdrHistory(
	query: string,
	options: { limit?: number; regex?: boolean; caseSensitive?: boolean; env?: NodeJS.ProcessEnv } = {},
): Promise<HistorySearchResult> {
	if (query.trim().length === 0) throw new Error("search query must not be empty");
	const limit = options.limit ?? 20;
	if (!Number.isInteger(limit) || limit < 1) throw new Error(`limit must be a positive integer; got ${limit}`);
	const root = resolveTranscriptRoot(options.env);
	const recordings = await listPaneRecordings(options.env).catch(() => [] as PaneRecordingSummary[]);
	const recordingsById = new Map(recordings.map((summary) => [summary.recordingId, summary]));
	try {
		const matches = await searchWithRipgrep(query, root, limit, options);
		return {
			query,
			root,
			engine: "ripgrep",
			matches: matches.slice(0, limit).map((match) => attributeMatch(match, root, recordingsById)),
			truncated: matches.length > limit,
		};
	} catch (error) {
		if (!isRipgrepUnavailable(error)) throw error;
	}
	const matches = await scanStore(query, root, limit, options);
	return {
		query,
		root,
		engine: "scan",
		matches: matches.slice(0, limit).map((match) => attributeMatch(match, root, recordingsById)),
		truncated: matches.length > limit,
	};
}

interface RawMatch {
	path: string;
	lineNumber: number;
	line: string;
}

async function searchWithRipgrep(
	query: string,
	root: string,
	limit: number,
	options: { regex?: boolean; caseSensitive?: boolean },
): Promise<RawMatch[]> {
	const args = [
		"--json",
		"--search-zip",
		"--max-columns",
		String(MATCH_LINE_MAX_CHARS * 2),
		"--glob",
		"*.txt",
		"--glob",
		"*.txt.gz",
		...(options.caseSensitive === true ? [] : ["--ignore-case"]),
		...(options.regex === true ? [] : ["--fixed-strings"]),
		"--",
		query,
		root,
	];
	let stdout: string;
	try {
		({ stdout } = await execFileAsync("rg", args, { maxBuffer: RG_MAX_BUFFER_BYTES }));
	} catch (error) {
		// rg exits 1 for "no matches" with empty stderr; that is a valid result.
		const failure = error as { code?: number | string; stdout?: string; stderr?: string };
		if (failure.code === 1 && (failure.stderr ?? "").length === 0) return [];
		throw error;
	}
	const matches: RawMatch[] = [];
	for (const line of stdout.split("\n")) {
		if (matches.length > limit) break;
		if (line.length === 0) continue;
		let parsed: { type?: string; data?: { path?: { text?: string }; line_number?: number; lines?: { text?: string } } };
		try {
			parsed = JSON.parse(line) as typeof parsed;
		} catch {
			continue;
		}
		if (parsed.type !== "match") continue;
		const path = parsed.data?.path?.text;
		const lineNumber = parsed.data?.line_number;
		const text = parsed.data?.lines?.text;
		if (path === undefined || lineNumber === undefined || text === undefined) continue;
		matches.push({ path, lineNumber, line: clipLine(text) });
	}
	return matches;
}

function isRipgrepUnavailable(error: unknown): boolean {
	return (error as NodeJS.ErrnoException).code === "ENOENT";
}

async function scanStore(
	query: string,
	root: string,
	limit: number,
	options: { regex?: boolean; caseSensitive?: boolean },
): Promise<RawMatch[]> {
	const caseSensitive = options.caseSensitive === true;
	const pattern =
		options.regex === true ? new RegExp(query, caseSensitive ? "u" : "iu") : undefined;
	const needle = caseSensitive ? query : query.toLowerCase();
	const matches: RawMatch[] = [];
	let scannedBytes = 0;
	const files = await collectSearchableFiles(root);
	for (const path of files) {
		if (matches.length > limit || scannedBytes >= SCAN_MAX_BYTES) break;
		const raw = await readFile(path).catch(() => undefined);
		if (raw === undefined) continue;
		scannedBytes += raw.length;
		let text: string;
		if (path.endsWith(".gz")) {
			const inflated = await gunzipAsync(raw).catch(() => undefined);
			if (inflated === undefined) continue;
			text = inflated.toString("utf8");
		} else {
			text = raw.toString("utf8");
		}
		const lines = text.split("\n");
		for (let index = 0; index < lines.length; index++) {
			const line = lines[index] ?? "";
			const hit =
				pattern !== undefined
					? pattern.test(line)
					: (caseSensitive ? line : line.toLowerCase()).includes(needle);
			if (!hit) continue;
			matches.push({ path, lineNumber: index + 1, line: clipLine(line) });
			if (matches.length > limit) break;
		}
	}
	return matches;
}

async function collectSearchableFiles(root: string): Promise<string[]> {
	const files: string[] = [];
	const stack = [root];
	while (stack.length > 0) {
		const dir = stack.pop();
		if (dir === undefined) break;
		const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
		for (const entry of entries) {
			const path = join(dir, entry.name);
			if (entry.isDirectory()) {
				stack.push(path);
				continue;
			}
			if (!entry.isFile()) continue;
			if (entry.name.endsWith(".txt") || entry.name.endsWith(".txt.gz")) files.push(path);
		}
	}
	return files.sort();
}

function attributeMatch(
	match: RawMatch,
	root: string,
	recordingsById: Map<string, PaneRecordingSummary>,
): HistorySearchMatch {
	const parts = relative(root, match.path).split(sep);
	if (parts[0] === PANE_RECORDINGS_DIR && parts.length >= 3) {
		const recordingId = parts[1] ?? "";
		const summary = recordingsById.get(recordingId);
		return {
			kind: "pane",
			id: recordingId,
			...(summary?.agent === undefined ? {} : { agent: summary.agent }),
			...(summary?.paneId === undefined ? {} : { paneId: summary.paneId }),
			...(summary?.label === undefined ? {} : { label: summary.label }),
			file: parts.slice(2).join(sep),
			lineNumber: match.lineNumber,
			line: match.line,
		};
	}
	return {
		kind: "worker",
		...(parts[0] === undefined ? {} : { agent: parts[0] }),
		id: parts[1] ?? "",
		file: parts.slice(2).join(sep),
		lineNumber: match.lineNumber,
		line: match.line,
	};
}

function clipLine(line: string): string {
	const trimmed = line.endsWith("\n") ? line.slice(0, -1) : line;
	return trimmed.length > MATCH_LINE_MAX_CHARS ? `${trimmed.slice(0, MATCH_LINE_MAX_CHARS)}…` : trimmed;
}
