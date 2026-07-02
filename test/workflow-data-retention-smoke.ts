import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	DEFAULT_WORKFLOW_RETENTION_HOURS,
	formatWorkflowPruneSummary,
	pruneWorkflowLocalData,
	resolveWorkflowDataDir,
	resolveWorkflowRetentionHours,
} from "../agent/lib/workflow-data-retention.ts";

function assert(condition: boolean, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

const HOUR_MS = 3_600_000;
const NOW_MS = Date.parse("2026-07-01T12:00:00.000Z");

const STALE_DONE = "wrun_01STALEDONE000000000000000";
const STALE_ZOMBIE = "wrun_01STALEZOMBIE00000000000000";
const FRESH = "wrun_01FRESH000000000000000000";
const ORPHAN_OLD = "wrun_01ORPHANOLD0000000000000000";
const ORPHAN_NEW = "wrun_01ORPHANNEW0000000000000000";

async function writeRun(dir: string, runId: string, status: string, updatedAtMs: number): Promise<void> {
	const record = {
		runId,
		status,
		createdAt: new Date(updatedAtMs).toISOString(),
		updatedAt: new Date(updatedAtMs).toISOString(),
	};
	await writeFile(join(dir, "runs", `${runId}.json`), JSON.stringify(record));
}

async function writeAged(path: string, content: string, mtimeMs: number): Promise<void> {
	await writeFile(path, content);
	await utimes(path, new Date(mtimeMs), new Date(mtimeMs));
}

function sha256Hex(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

/** Token claim + recovery marker names, as @workflow/world-local derives them. */
function hookTokenSidecarNames(runId: string): string[] {
	const hookId = `hook_${runId.slice("wrun_".length)}`;
	const token = `${runId}:auth`;
	return [
		`${sha256Hex(token)}.json`,
		`${sha256Hex(`${token}\x00${runId}\x00${hookId}`)}.recovery.json`,
	];
}

async function buildFixture(): Promise<string> {
	const dataDir = await mkdtemp(join(tmpdir(), "clanky-workflow-retention-"));
	for (const sub of [
		"runs",
		"events",
		"steps",
		join("hooks", "tokens"),
		join("streams", "runs"),
		join("streams", "chunks"),
	]) {
		await mkdir(join(dataDir, sub), { recursive: true });
	}
	const staleMs = NOW_MS - 100 * HOUR_MS;
	await writeRun(dataDir, STALE_DONE, "completed", staleMs);
	await writeRun(dataDir, STALE_ZOMBIE, "running", staleMs);
	await writeRun(dataDir, FRESH, "running", NOW_MS - HOUR_MS);
	for (const runId of [STALE_DONE, STALE_ZOMBIE, FRESH]) {
		await writeFile(join(dataDir, "events", `${runId}-evnt_01E.json`), "{}");
		await writeFile(join(dataDir, "steps", `${runId}-step_01S.json`), "{}");
		const hookId = `hook_${runId.slice(5)}`;
		const token = `${runId}:auth`;
		await writeFile(join(dataDir, "hooks", `${hookId}.json`), JSON.stringify({ hookId, runId, token }));
		// All sidecars are aged stale: a live run's sidecars must survive on
		// the hook reference alone (a parked HITL run can be far older than
		// the retention window), never on their mtime.
		for (const sidecarName of hookTokenSidecarNames(runId)) {
			await writeAged(join(dataDir, "hooks", "tokens", sidecarName), "{}", staleMs);
		}
		await writeFile(join(dataDir, "streams", "runs", `${runId}.json`), "{}");
		const ulid = runId.slice("wrun_".length);
		await writeFile(join(dataDir, "streams", "chunks", `strm_${ulid}_user-chnk_01C.bin`), "x");
	}
	await writeAged(join(dataDir, "events", `${ORPHAN_OLD}-evnt_01E.json`), "{}", staleMs);
	await writeAged(join(dataDir, "events", `${ORPHAN_NEW}-evnt_01E.json`), "{}", NOW_MS);
	await writeAged(join(dataDir, "hooks", "hook_01UNPARSABLE.json"), "not json", NOW_MS);
	await writeAged(join(dataDir, "hooks", "tokens", `${sha256Hex("orphan-old-token")}.json`), "{}", staleMs);
	await writeAged(join(dataDir, "hooks", "tokens", `${sha256Hex("orphan-new-token")}.json`), "{}", NOW_MS);
	return dataDir;
}

const dataDir = await buildFixture();
try {
	const disabled = await pruneWorkflowLocalData(dataDir, 0, NOW_MS);
	assert(disabled === undefined, "retention <= 0 must disable pruning");
	assert((await readdir(join(dataDir, "runs"))).length === 3, "disabled prune must not delete anything");

	const missing = await pruneWorkflowLocalData(join(dataDir, "does-not-exist"), 48, NOW_MS);
	assert(missing === undefined, "missing store must return undefined");

	const counts = await pruneWorkflowLocalData(dataDir, 48, NOW_MS);
	assert(counts !== undefined, "prune must return counts for an existing store");
	assert(counts.runs === 2, `expected 2 pruned runs, got ${counts.runs}`);
	assert(counts.events === 3, `expected 3 pruned events (2 stale + 1 old orphan), got ${counts.events}`);
	assert(counts.steps === 2, `expected 2 pruned steps, got ${counts.steps}`);
	assert(counts.hooks === 2, `expected 2 pruned hooks, got ${counts.hooks}`);
	assert(
		counts.hookTokens === 5,
		`expected 5 pruned hook token sidecars (2 stale hooks x 2 + 1 old orphan), got ${counts.hookTokens}`,
	);
	assert(counts.streamRuns === 2, `expected 2 pruned stream runs, got ${counts.streamRuns}`);
	assert(counts.streamChunks === 2, `expected 2 pruned stream chunks, got ${counts.streamChunks}`);

	const remainingRuns = await readdir(join(dataDir, "runs"));
	assert(remainingRuns.length === 1 && remainingRuns[0] === `${FRESH}.json`, "fresh run must survive");
	const remainingEvents = await readdir(join(dataDir, "events"));
	assert(remainingEvents.length === 2, "fresh run event and fresh orphan event must survive");
	assert(
		remainingEvents.some((name) => name.startsWith(ORPHAN_NEW)),
		"fresh orphan event must survive",
	);
	const remainingHooks = await readdir(join(dataDir, "hooks"));
	assert(
		remainingHooks.length === 3 &&
			remainingHooks.includes("hook_01UNPARSABLE.json") &&
			remainingHooks.includes("tokens"),
		"fresh-run hook and fresh unparsable hook must survive",
	);
	const remainingSidecars = (await readdir(join(dataDir, "hooks", "tokens"))).sort();
	const expectedSidecars = [...hookTokenSidecarNames(FRESH), `${sha256Hex("orphan-new-token")}.json`].sort();
	assert(
		remainingSidecars.length === expectedSidecars.length &&
			remainingSidecars.every((name, index) => name === expectedSidecars[index]),
		`fresh hook sidecars and fresh orphan sidecar must survive, got ${remainingSidecars.join(", ")}`,
	);
	assert((await readdir(join(dataDir, "streams", "runs"))).length === 1, "fresh stream run must survive");
	assert((await readdir(join(dataDir, "streams", "chunks"))).length === 1, "fresh stream chunk must survive");

	const again = await pruneWorkflowLocalData(dataDir, 48, NOW_MS);
	assert(again !== undefined && formatWorkflowPruneSummary(again) === undefined, "second prune must be a no-op");

	assert(
		resolveWorkflowRetentionHours({}) === DEFAULT_WORKFLOW_RETENTION_HOURS,
		"retention default must apply when env is unset",
	);
	assert(
		resolveWorkflowRetentionHours({ CLANKY_WORKFLOW_RETENTION_HOURS: "12" }) === 12,
		"retention env override must parse",
	);
	assert(
		resolveWorkflowRetentionHours({ CLANKY_WORKFLOW_RETENTION_HOURS: "junk" }) === DEFAULT_WORKFLOW_RETENTION_HOURS,
		"unparsable retention env must fall back to the default",
	);
	assert(
		resolveWorkflowDataDir({}, "/repo") === join("/repo", ".workflow-data"),
		"data dir must default to .workflow-data under the repo",
	);
	assert(
		resolveWorkflowDataDir({ WORKFLOW_LOCAL_DATA_DIR: "/elsewhere/data" }, "/repo") === "/elsewhere/data",
		"absolute data dir override must win",
	);

	process.stdout.write("workflow-data-retention smoke passed\n");
} finally {
	await rm(dataDir, { recursive: true, force: true });
}
