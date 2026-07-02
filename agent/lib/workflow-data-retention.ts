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
 *
 * Hooks additionally own hash-named sidecars under `hooks/tokens/` (the
 * token claim file and the recovery marker) that are only reachable through
 * the hook body; unreferenced sidecars older than the cutoff are swept so
 * they cannot accumulate and stale tokens are freed for reuse.
 */

import { createHash } from "node:crypto";
import { readdir, readFile, rm, stat } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

export type WorkflowDataPruneCounts = {
	runs: number;
	events: number;
	steps: number;
	hooks: number;
	hookTokens: number;
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
		counts.runs +
		counts.events +
		counts.steps +
		counts.hooks +
		counts.hookTokens +
		counts.streamRuns +
		counts.streamChunks;
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

	const counts: WorkflowDataPruneCounts = {
		runs: 0,
		events: 0,
		steps: 0,
		hooks: 0,
		hookTokens: 0,
		streamRuns: 0,
		streamChunks: 0,
	};
	for (const runId of staleRunIds) {
		await rm(join(runsDir, `${runId}.json`), { force: true });
		counts.runs += 1;
	}
	counts.events = await pruneRunLinkedFiles(join(dataDir, "events"), extractEventRunId, staleRunIds, liveRunIds, cutoffMs);
	counts.steps = await pruneRunLinkedFiles(join(dataDir, "steps"), extractEventRunId, staleRunIds, liveRunIds, cutoffMs);
	const hookCounts = await pruneHooks(join(dataDir, "hooks"), staleRunIds, liveRunIds, cutoffMs);
	counts.hooks = hookCounts.hooks;
	counts.hookTokens = hookCounts.hookTokens;
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

/**
 * Hooks carry their run linkage inside the JSON body rather than the
 * filename. While deciding which hooks to remove, the sidecar names of every
 * surviving hook are collected so the token sidecar sweep afterwards knows
 * which `hooks/tokens/` entries are still referenced; everything else ages
 * out. Deleted hooks need no inline sidecar cleanup — a stale hook's
 * sidecars were last touched no later than its run, so the sweep removes
 * them in the same pass.
 */
async function pruneHooks(
	dir: string,
	staleRunIds: ReadonlySet<string>,
	liveRunIds: ReadonlySet<string>,
	cutoffMs: number,
): Promise<{ hooks: number; hookTokens: number }> {
	const entries = await listDirectory(dir);
	if (entries === undefined) return { hooks: 0, hookTokens: 0 };
	let removed = 0;
	const referencedSidecarNames = new Set<string>();
	for (const name of entries) {
		if (!name.endsWith(".json")) continue;
		const path = join(dir, name);
		const hook = await readHookRecord(path);
		const runId = hook?.runId;
		let keep: boolean;
		if (runId !== undefined && liveRunIds.has(runId)) {
			keep = true;
		} else if (runId !== undefined && staleRunIds.has(runId)) {
			keep = false;
		} else {
			const mtimeMs = await fileMtimeMs(path);
			keep = mtimeMs === undefined || mtimeMs >= cutoffMs;
		}
		if (keep) {
			if (hook !== undefined) {
				for (const sidecarName of hookTokenSidecarNames(hook)) referencedSidecarNames.add(sidecarName);
			}
			continue;
		}
		await rm(path, { force: true });
		removed += 1;
	}
	const hookTokens = await pruneOrphanedTokenSidecars(join(dir, "tokens"), referencedSidecarNames, cutoffMs);
	return { hooks: removed, hookTokens };
}

type HookRecord = {
	hookId: string | undefined;
	runId: string | undefined;
	token: string | undefined;
};

async function readHookRecord(path: string): Promise<HookRecord | undefined> {
	let record: unknown;
	try {
		record = JSON.parse(await readFile(path, "utf8"));
	} catch {
		return undefined;
	}
	if (typeof record !== "object" || record === null) return undefined;
	const fields = record as Record<string, unknown>;
	return {
		hookId: typeof fields.hookId === "string" ? fields.hookId : undefined,
		runId: typeof fields.runId === "string" ? fields.runId : undefined,
		token: typeof fields.token === "string" ? fields.token : undefined,
	};
}

/**
 * Sidecar filenames a hook owns under `hooks/tokens/`: the token claim file
 * (`sha256(token).json`, which also keeps the token claimed against reuse)
 * and the recovery marker (`sha256(token \0 runId \0 hookId).recovery.json`).
 * The derivations mirror `hashToken` / `hookRecoveryMarkerPath` in
 * `@workflow/world-local`'s storage helpers, which the package does not
 * export.
 */
function hookTokenSidecarNames(hook: HookRecord): string[] {
	if (hook.token === undefined) return [];
	const names = [`${sha256Hex(hook.token)}.json`];
	if (hook.runId !== undefined && hook.hookId !== undefined) {
		names.push(`${sha256Hex(`${hook.token}\x00${hook.runId}\x00${hook.hookId}`)}.recovery.json`);
	}
	return names;
}

function sha256Hex(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

/**
 * Remove `hooks/tokens/` sidecars no surviving hook references once they age
 * past the cutoff. This covers sidecars of hooks pruned in this pass, leaks
 * from earlier pruner versions that removed hooks without their sidecars,
 * and interrupted prunes. Fresh unreferenced sidecars survive: the SDK
 * writes the token claim before the hook file when creating a hook.
 */
async function pruneOrphanedTokenSidecars(
	tokensDir: string,
	referencedSidecarNames: ReadonlySet<string>,
	cutoffMs: number,
): Promise<number> {
	const entries = await listDirectory(tokensDir);
	if (entries === undefined) return 0;
	let removed = 0;
	for (const name of entries) {
		if (!name.endsWith(".json") || referencedSidecarNames.has(name)) continue;
		const path = join(tokensDir, name);
		const mtimeMs = await fileMtimeMs(path);
		if (mtimeMs === undefined || mtimeMs >= cutoffMs) continue;
		await rm(path, { force: true });
		removed += 1;
	}
	return removed;
}
