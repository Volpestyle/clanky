/**
 * Retention pruning for the eve dev local workflow store (`.workflow-data`).
 *
 * eve's dev-mode workflow queue (Vercel Workflow SDK local world) persists
 * every run as individual JSON files and lists whole directories with a
 * suffix filter on each queue operation. The store grows without bound, and
 * once thousands of files accumulate the per-operation directory scans burn
 * multiple CPU cores while workflow traffic is active (see ADR-0008).
 *
 * Pruning runs only at brain spawn, before the eve dev server boots, so the
 * queue is never scanning while files disappear underneath it. A run is
 * stale when its record's `updatedAt` (falling back to `createdAt`, then
 * file mtime) is older than the retention window; dev-server kills strand
 * runs in `running` status forever, so status is deliberately not consulted.
 */

import { readdir, readFile, rm, stat } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

export type WorkflowDataPruneCounts = {
	runs: number;
	events: number;
	steps: number;
	hooks: number;
	streamRuns: number;
	streamChunks: number;
};

export const DEFAULT_WORKFLOW_RETENTION_HOURS = 48;
export const WORKFLOW_RETENTION_HOURS_ENV = "CLANKY_WORKFLOW_RETENTION_HOURS";

const RUN_FILE_PREFIX = "wrun_";
const STREAM_CHUNK_PREFIX = "strm_";
const HOUR_MS = 3_600_000;

export function resolveWorkflowRetentionHours(env: NodeJS.ProcessEnv): number {
	const raw = env[WORKFLOW_RETENTION_HOURS_ENV]?.trim();
	if (raw === undefined || raw.length === 0) return DEFAULT_WORKFLOW_RETENTION_HOURS;
	const parsed = Number.parseFloat(raw);
	return Number.isFinite(parsed) ? parsed : DEFAULT_WORKFLOW_RETENTION_HOURS;
}

export function resolveWorkflowDataDir(env: NodeJS.ProcessEnv, repoRoot: string): string {
	const override = env.WORKFLOW_LOCAL_DATA_DIR;
	if (override === undefined || override.length === 0) return join(repoRoot, ".workflow-data");
	return isAbsolute(override) ? override : resolve(repoRoot, override);
}

export function formatWorkflowPruneSummary(counts: WorkflowDataPruneCounts): string | undefined {
	const total =
		counts.runs + counts.events + counts.steps + counts.hooks + counts.streamRuns + counts.streamChunks;
	if (total === 0) return undefined;
	return `pruned ${counts.runs} stale workflow runs (${total} files) from the local workflow store`;
}

/**
 * Prune stale runs and their linked events, steps, hooks, and stream files.
 * Returns undefined when retention is disabled (`retentionHours <= 0`) or the
 * store does not exist yet. Must only be called while no eve server is using
 * the store.
 */
export async function pruneWorkflowLocalData(
	dataDir: string,
	retentionHours: number,
	nowMs: number = Date.now(),
): Promise<WorkflowDataPruneCounts | undefined> {
	if (retentionHours <= 0) return undefined;
	const cutoffMs = nowMs - retentionHours * HOUR_MS;
	const runsDir = join(dataDir, "runs");
	const runFiles = await listDirectory(runsDir);
	if (runFiles === undefined) return undefined;

	const staleRunIds = new Set<string>();
	const liveRunIds = new Set<string>();
	for (const name of runFiles) {
		if (!name.startsWith(RUN_FILE_PREFIX) || !name.endsWith(".json")) continue;
		const runId = name.slice(0, -".json".length);
		const touchedMs = await runLastTouchedMs(join(runsDir, name));
		if (touchedMs !== undefined && touchedMs < cutoffMs) staleRunIds.add(runId);
		else liveRunIds.add(runId);
	}

	const counts: WorkflowDataPruneCounts = { runs: 0, events: 0, steps: 0, hooks: 0, streamRuns: 0, streamChunks: 0 };
	for (const runId of staleRunIds) {
		await rm(join(runsDir, `${runId}.json`), { force: true });
		counts.runs += 1;
	}
	counts.events = await pruneRunLinkedFiles(join(dataDir, "events"), extractEventRunId, staleRunIds, liveRunIds, cutoffMs);
	counts.steps = await pruneRunLinkedFiles(join(dataDir, "steps"), extractEventRunId, staleRunIds, liveRunIds, cutoffMs);
	counts.hooks = await pruneHooks(join(dataDir, "hooks"), staleRunIds, liveRunIds, cutoffMs);
	counts.streamRuns = await pruneRunLinkedFiles(
		join(dataDir, "streams", "runs"),
		extractStreamRunRunId,
		staleRunIds,
		liveRunIds,
		cutoffMs,
	);
	counts.streamChunks = await pruneRunLinkedFiles(
		join(dataDir, "streams", "chunks"),
		extractStreamChunkRunId,
		staleRunIds,
		liveRunIds,
		cutoffMs,
	);
	return counts;
}

async function listDirectory(dir: string): Promise<string[] | undefined> {
	try {
		return await readdir(dir);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

/** Last-activity timestamp for a run record; file mtime when the JSON is unreadable. */
async function runLastTouchedMs(runPath: string): Promise<number | undefined> {
	let record: unknown;
	try {
		record = JSON.parse(await readFile(runPath, "utf8"));
	} catch {
		return await fileMtimeMs(runPath);
	}
	if (typeof record === "object" && record !== null) {
		const fields = record as Record<string, unknown>;
		for (const key of ["updatedAt", "createdAt"]) {
			const value = fields[key];
			if (typeof value !== "string") continue;
			const parsed = Date.parse(value);
			if (!Number.isNaN(parsed)) return parsed;
		}
	}
	return await fileMtimeMs(runPath);
}

async function fileMtimeMs(path: string): Promise<number | undefined> {
	try {
		return (await stat(path)).mtimeMs;
	} catch {
		return undefined;
	}
}

/** `wrun_<ulid>-evnt_<ulid>.json` / `wrun_<ulid>-step_<ulid>.json` */
function extractEventRunId(name: string): string | undefined {
	if (!name.startsWith(RUN_FILE_PREFIX)) return undefined;
	const separator = name.indexOf("-");
	if (separator <= RUN_FILE_PREFIX.length) return undefined;
	return name.slice(0, separator);
}

/** `wrun_<ulid>.json` */
function extractStreamRunRunId(name: string): string | undefined {
	if (!name.startsWith(RUN_FILE_PREFIX) || !name.endsWith(".json")) return undefined;
	return name.slice(0, -".json".length);
}

/** `strm_<ulid>_<stream>-chnk_<ulid>.bin` — the ULID matches the run's. */
function extractStreamChunkRunId(name: string): string | undefined {
	if (!name.startsWith(STREAM_CHUNK_PREFIX)) return undefined;
	const separator = name.indexOf("_", STREAM_CHUNK_PREFIX.length);
	if (separator === -1) return undefined;
	return `${RUN_FILE_PREFIX}${name.slice(STREAM_CHUNK_PREFIX.length, separator)}`;
}

/**
 * Remove entries whose run is stale, plus orphans (run record already gone)
 * older than the cutoff. Fresh orphans survive: a run mid-creation writes its
 * linked files before its record.
 */
async function pruneRunLinkedFiles(
	dir: string,
	extractRunId: (name: string) => string | undefined,
	staleRunIds: ReadonlySet<string>,
	liveRunIds: ReadonlySet<string>,
	cutoffMs: number,
): Promise<number> {
	const entries = await listDirectory(dir);
	if (entries === undefined) return 0;
	let removed = 0;
	for (const name of entries) {
		const runId = extractRunId(name);
		if (runId === undefined || liveRunIds.has(runId)) continue;
		const path = join(dir, name);
		if (!staleRunIds.has(runId)) {
			const mtimeMs = await fileMtimeMs(path);
			if (mtimeMs === undefined || mtimeMs >= cutoffMs) continue;
		}
		await rm(path, { force: true, recursive: true });
		removed += 1;
	}
	return removed;
}

/** Hooks carry their run linkage inside the JSON body rather than the filename. */
async function pruneHooks(
	dir: string,
	staleRunIds: ReadonlySet<string>,
	liveRunIds: ReadonlySet<string>,
	cutoffMs: number,
): Promise<number> {
	const entries = await listDirectory(dir);
	if (entries === undefined) return 0;
	let removed = 0;
	for (const name of entries) {
		if (!name.endsWith(".json")) continue;
		const path = join(dir, name);
		const runId = await hookRunId(path);
		if (runId !== undefined && liveRunIds.has(runId)) continue;
		if (runId === undefined || !staleRunIds.has(runId)) {
			const mtimeMs = await fileMtimeMs(path);
			if (mtimeMs === undefined || mtimeMs >= cutoffMs) continue;
		}
		await rm(path, { force: true });
		removed += 1;
	}
	return removed;
}

async function hookRunId(path: string): Promise<string | undefined> {
	let record: unknown;
	try {
		record = JSON.parse(await readFile(path, "utf8"));
	} catch {
		return undefined;
	}
	if (typeof record !== "object" || record === null) return undefined;
	const runId = (record as Record<string, unknown>).runId;
	return typeof runId === "string" ? runId : undefined;
}
