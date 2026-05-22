import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SwarmLeader, type SwarmLeaderEvent } from "@clanky/swarm";

const profileDir = await mkdtemp(join(tmpdir(), "clanky-swarm-"));
const events: SwarmLeaderEvent[] = [];
const leader = new SwarmLeader({
	profile: "test",
	profileDir,
	cwd: process.cwd(),
	env: {
		CLANKY_SWARM_ENABLED: "1",
		CLANKY_SWARM_COMMAND: process.execPath,
		CLANKY_SWARM_ARGS_JSON: JSON.stringify(["--import", "tsx", "packages/clanky-swarm/test/faux-swarm-mcp.ts"]),
		AGENT_IDENTITY: "test",
		HERDR_PANE_ID: "pane-clanky-smoke",
		HERDR_SOCKET: "/tmp/legacy-herdr-smoke.sock",
		HERDR_SOCKET_PATH: "/tmp/herdr-smoke.sock",
		SWARM_HARNESS_CODEX: "codex-smoke-worker",
		SWARM_HERDR_BIN: "/tmp/herdr-smoke-bin",
		SWARM_HERDR_PARENT_PANE: "pane-clanky-parent",
		SWARM_WORKER_HARNESS: "/tmp/clanky-worker-harness",
	},
});
leader.subscribe((event) => {
	events.push(event);
});

try {
	await leader.start();
	const status = leader.status();
	if (status.state !== "booted" || status.instanceId !== "clanky-faux-gateway") {
		throw new Error(`Swarm leader did not boot through faux MCP server: ${JSON.stringify(status)}`);
	}

	const snapshot = await leader.snapshot();
	if (!snapshot.ok || !Array.isArray(snapshot.instances) || !Array.isArray(snapshot.tasks)) {
		throw new Error(`Swarm snapshot did not include faux instances and tasks: ${JSON.stringify(snapshot)}`);
	}
	const health = recordProperty(snapshot.health);
	const kv = recordProperty(health?.kv);
	const childEnv = recordProperty(health?.env);
	if (
		childEnv?.AGENT_IDENTITY !== "test" ||
		childEnv.SWARM_DB_PATH !== join(profileDir, "swarm", "swarm.db") ||
		childEnv.SWARM_MCP_DIRECTORY !== process.cwd() ||
		childEnv.SWARM_MCP_SCOPE !== process.cwd() ||
		childEnv.SWARM_MCP_FILE_ROOT !== process.cwd() ||
		childEnv.HERDR_PANE_ID !== "pane-clanky-smoke" ||
		childEnv.HERDR_SOCKET_PATH !== "/tmp/herdr-smoke.sock" ||
		childEnv.SWARM_HARNESS_CODEX !== "codex-smoke-worker" ||
		childEnv.SWARM_HERDR_BIN !== "/tmp/herdr-smoke-bin" ||
		childEnv.SWARM_HERDR_PARENT_PANE !== "pane-clanky-parent" ||
		childEnv.SWARM_WORKER_HARNESS !== "/tmp/clanky-worker-harness"
	) {
		throw new Error(`Swarm leader spawned swarm-mcp with unexpected environment: ${JSON.stringify(childEnv)}`);
	}
	const workspaceValue = kv?.["identity/workspace/herdr/clanky-faux-gateway"];
	if (typeof workspaceValue !== "string") {
		throw new Error(`Swarm leader did not publish a herdr workspace handle: ${JSON.stringify(snapshot.health)}`);
	}
	const workspace = JSON.parse(workspaceValue) as unknown;
	if (
		!isRecord(workspace) ||
		workspace.backend !== "herdr" ||
		workspace.handle_kind !== "pane" ||
		workspace.handle !== "pane-clanky-smoke" ||
		workspace.socket_path !== "/tmp/herdr-smoke.sock"
	) {
		throw new Error(`Swarm leader published an unexpected herdr workspace handle: ${workspaceValue}`);
	}

	const dispatch = await leader.dispatch({
		title: "Implement the faux smoke task",
		type: "implement",
		description: "Exercise clanky swarm dispatch plumbing.",
		files: ["README.md"],
		provider: "anthropic",
		model: "claude-opus-4-5",
		linearIssue: "PROJ-123",
		idempotencyKey: "swarm-smoke-1",
	});
	if (!dispatch.ok || dispatch.taskId !== "task-1") {
		throw new Error(`Swarm dispatch failed: ${JSON.stringify(dispatch)}`);
	}
	if (dispatch.request.provider !== "anthropic" || dispatch.request.model !== "claude-opus-4-5") {
		throw new Error(`Swarm dispatch did not preserve model override in the request: ${JSON.stringify(dispatch)}`);
	}
	if (!JSON.stringify(dispatch.response).includes("claude-opus-4-5")) {
		throw new Error(
			`Swarm dispatch did not forward model override to worker instructions: ${JSON.stringify(dispatch)}`,
		);
	}
	const duplicateDispatch = await leader.dispatch({
		title: "Implement the faux smoke task again",
		type: "implement",
		description: "Exercise idempotent clanky swarm dispatch plumbing.",
		files: ["README.md"],
		linearIssue: "PROJ-123",
		idempotencyKey: "swarm-smoke-1",
	});
	const duplicateResponse = recordProperty(duplicateDispatch.response);
	const deduplicated = duplicateResponse?.deduplicated === true;
	if (!duplicateDispatch.ok || duplicateDispatch.taskId !== "task-1" || !deduplicated) {
		throw new Error(`Swarm dispatch idempotency failed: ${JSON.stringify(duplicateDispatch)}`);
	}
	const fastCompletedDispatch = await leader.dispatch({
		title: "Exercise fast completion race",
		type: "implement",
		description: "Worker completes before swarm-mcp finishes dispatch task binding.",
		files: ["README.md"],
		idempotencyKey: "swarm-smoke-fast-complete",
	});
	if (!fastCompletedDispatch.ok || fastCompletedDispatch.dispatchStatus !== "done") {
		throw new Error(
			`Swarm dispatch did not recover a fast terminal binding race: ${JSON.stringify(fastCompletedDispatch)}`,
		);
	}
	const fastClaimedDispatch = await leader.dispatch({
		title: "Exercise fast claim race",
		type: "implement",
		description: "Worker claims before swarm-mcp finishes dispatch task binding.",
		files: ["README.md"],
		idempotencyKey: "swarm-smoke-fast-claim",
	});
	if (!fastClaimedDispatch.ok || fastClaimedDispatch.dispatchStatus !== "in_progress") {
		throw new Error(`Swarm dispatch did not recover a fast claim binding race: ${JSON.stringify(fastClaimedDispatch)}`);
	}

	const lock = await leader.getFileLock("locked-file.ts");
	if (!lock.ok || !lock.blocked || lock.ownerId !== "clanky-faux-worker") {
		throw new Error(`Swarm file lock did not block another owner's lock: ${JSON.stringify(lock)}`);
	}

	const message = await leader.message({
		recipient: "clanky-faux-worker",
		message: "Cron summary is ready.",
		taskId: "task-1",
		nudge: false,
		force: true,
	});
	if (!message.ok) {
		throw new Error(`Swarm message failed: ${JSON.stringify(message)}`);
	}

	const cronDelivery = await leader.deliverCronOutput("clanky-faux-worker", "Digest body");
	if (!cronDelivery.ok) {
		throw new Error(`Swarm cron delivery failed: ${JSON.stringify(cronDelivery)}`);
	}

	const complete = await leader.complete({
		taskId: "task-1",
		summary: "Faux task completed.",
		filesChanged: ["README.md"],
		tests: [{ command: "pnpm check", status: "passed" }],
		trackerUpdateSkipped: { reason: "local faux smoke" },
	});
	if (!complete.ok) {
		throw new Error(`Swarm complete failed: ${JSON.stringify(complete)}`);
	}

	await waitFor(() => events.some((event) => event.type === "swarm.activity"));
	await waitFor(async () => {
		const latest = await leader.snapshot();
		const latestHealth = recordProperty(latest.health);
		const latestKv = recordProperty(latestHealth?.kv);
		return typeof latestKv?.["owner/planner"] === "string";
	});
	const ownerSnapshot = await leader.snapshot();
	const ownerHealth = recordProperty(ownerSnapshot.health);
	const ownerKv = recordProperty(ownerHealth?.kv);
	const ownerValue = ownerKv?.["owner/planner"];
	if (typeof ownerValue !== "string" || !ownerValue.includes("clanky-faux-gateway")) {
		throw new Error(`Swarm leader did not repair missing planner ownership: ${JSON.stringify(ownerSnapshot.health)}`);
	}

	console.log(
		JSON.stringify({
			instanceId: status.instanceId,
			events: events.length,
			taskId: dispatch.taskId,
			deduplicated,
			fastCompletedTaskId: fastCompletedDispatch.taskId,
			fastClaimedTaskId: fastClaimedDispatch.taskId,
			workspacePublished: true,
			lockBlocked: lock.blocked,
			plannerOwnerRepaired: true,
		}),
	);
} finally {
	await leader.close();
	await rm(profileDir, { force: true, recursive: true });
}

async function waitFor(predicate: () => boolean | Promise<boolean>): Promise<void> {
	const deadline = Date.now() + 3000;
	while (Date.now() < deadline) {
		if (await predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	throw new Error("Timed out waiting for swarm activity event");
}

function recordProperty(value: unknown): Record<string, unknown> | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	return value as Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
