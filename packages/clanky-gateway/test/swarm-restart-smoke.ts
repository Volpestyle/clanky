import { type ChildProcess, spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveClankyPaths } from "@clanky/core";
import {
	requestGateway,
	type StatusResult,
	type SwarmDispatchGatewayResult,
	type SwarmQueryGatewayResult,
} from "@clanky/gateway";

const homeDir = await mkdtemp(join(tmpdir(), "clanky-swarm-restart-"));
const stateFile = join(homeDir, "faux-swarm-state.json");
const paths = resolveClankyPaths({ homeDir });
const idempotencyKey = "swarm-restart-smoke";
let child: ChildProcess | undefined;

try {
	child = spawnGateway();
	await waitForSocket(paths.socketFile);
	const status = (await requestGateway({ socketFile: paths.socketFile, method: "status" })) as StatusResult;
	if (status.swarm.state !== "booted") {
		throw new Error(`Expected swarm to boot before restart smoke dispatch: ${JSON.stringify(status.swarm)}`);
	}
	const dispatch = (await requestGateway({
		socketFile: paths.socketFile,
		method: "swarm.dispatch",
		params: {
			title: "Exercise swarm restart idempotency",
			type: "implement",
			description: "Dispatch before killing the gateway, then redispatch after restart.",
			files: ["README.md"],
			idempotency_key: idempotencyKey,
		},
	})) as SwarmDispatchGatewayResult;
	if (!dispatch.ok || dispatch.taskId === undefined || dispatch.dispatchStatus !== "dispatched") {
		throw new Error(`Expected initial swarm dispatch to succeed: ${JSON.stringify(dispatch)}`);
	}

	child.kill("SIGKILL");
	await waitForClose(child);
	child = undefined;
	await markTaskDone(stateFile, dispatch.taskId);

	child = spawnGateway();
	await waitForSocket(paths.socketFile);
	const tasks = (await requestGateway({
		socketFile: paths.socketFile,
		method: "swarm.tasks",
	})) as SwarmQueryGatewayResult;
	if (!hasTaskWithStatus(tasks.data, dispatch.taskId, "done")) {
		throw new Error(`Restarted daemon did not see completed swarm task ${dispatch.taskId}: ${JSON.stringify(tasks)}`);
	}
	const duplicate = (await requestGateway({
		socketFile: paths.socketFile,
		method: "swarm.dispatch",
		params: {
			title: "Exercise swarm restart idempotency duplicate",
			type: "implement",
			description: "Duplicate dispatch after restart should reuse the completed task.",
			files: ["README.md"],
			idempotency_key: idempotencyKey,
		},
	})) as SwarmDispatchGatewayResult;
	const duplicateResponse = recordProperty(duplicate.response);
	if (
		!duplicate.ok ||
		duplicate.taskId !== dispatch.taskId ||
		duplicate.dispatchStatus !== "done" ||
		duplicateResponse?.deduplicated !== true
	) {
		throw new Error(`Duplicate dispatch after restart did not reuse the completed task: ${JSON.stringify(duplicate)}`);
	}

	await requestGateway({ socketFile: paths.socketFile, method: "shutdown" });
	await waitForClose(child);
	child = undefined;

	console.log(
		JSON.stringify({
			taskId: dispatch.taskId,
			initialStatus: dispatch.dispatchStatus,
			duplicateStatus: duplicate.dispatchStatus,
			deduplicated: true,
		}),
	);
} finally {
	if (child !== undefined && child.exitCode === null && child.signalCode === null) {
		child.kill("SIGTERM");
		await waitForClose(child).catch(() => undefined);
	}
	await rm(homeDir, { force: true, recursive: true });
}

function spawnGateway(): ChildProcess {
	return spawn(process.execPath, ["--import", "tsx", "packages/clanky-cli/src/bin.ts", "start", "--home", homeDir], {
		cwd: process.cwd(),
		stdio: ["ignore", "pipe", "pipe"],
		env: {
			...process.env,
			CLANKY_SWARM_ENABLED: "1",
			CLANKY_SWARM_COMMAND: process.execPath,
			CLANKY_SWARM_ARGS_JSON: JSON.stringify(["--import", "tsx", "packages/clanky-swarm/test/faux-swarm-mcp.ts"]),
			SWARM_HARNESS_FAUX_SWARM_STATE_FILE: stateFile,
		},
	});
}

async function markTaskDone(file: string, taskId: string): Promise<void> {
	const state = JSON.parse(await readFile(file, "utf8")) as unknown;
	if (!isRecord(state)) throw new Error(`Faux swarm state file was not an object: ${JSON.stringify(state)}`);
	const tasks = recordProperty(state, "dispatchedTasks");
	if (tasks === undefined)
		throw new Error(`Faux swarm state did not include dispatchedTasks: ${JSON.stringify(state)}`);
	const task = recordProperty(tasks, taskId);
	if (task === undefined) throw new Error(`Faux swarm state did not include task ${taskId}: ${JSON.stringify(state)}`);
	task.status = "done";
	task.result = { summary: "completed while gateway was down" };
	await writeFile(file, `${JSON.stringify(state, null, 2)}\n`);
}

function hasTaskWithStatus(value: unknown, taskId: string, status: string): boolean {
	const rows = Array.isArray(value) ? value : recordArrayProperty(value, "data");
	return rows.some((row) => isRecord(row) && (row.id === taskId || row.task_id === taskId) && row.status === status);
}

function recordArrayProperty(value: unknown, key: string): unknown[] {
	if (!isRecord(value)) return [];
	const item = value[key];
	return Array.isArray(item) ? item : [];
}

function recordProperty(value: unknown, key?: string): Record<string, unknown> | undefined {
	const item = key === undefined ? value : isRecord(value) ? value[key] : undefined;
	return isRecord(item) ? item : undefined;
}

async function waitForSocket(socketFile: string): Promise<void> {
	const deadline = Date.now() + 15_000;
	while (Date.now() < deadline) {
		if (await canConnect(socketFile)) return;
		await sleep(50);
	}
	throw new Error(`Timed out waiting for daemon socket ${socketFile}`);
}

async function canConnect(socketFile: string): Promise<boolean> {
	return await new Promise<boolean>((resolve) => {
		const socket = createConnection(socketFile);
		const timeout = setTimeout(() => {
			socket.destroy();
			resolve(false);
		}, 100);
		socket.once("connect", () => {
			clearTimeout(timeout);
			socket.end();
			resolve(true);
		});
		socket.once("error", () => {
			clearTimeout(timeout);
			resolve(false);
		});
	});
}

async function waitForClose(process: ChildProcess): Promise<void> {
	if (process.exitCode !== null || process.signalCode !== null) return;
	await new Promise<void>((resolve) => process.once("close", () => resolve()));
}

async function sleep(ms: number): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, ms));
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
