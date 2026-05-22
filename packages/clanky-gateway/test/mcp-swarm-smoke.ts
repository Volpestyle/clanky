import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startGatewayServer } from "@clanky/gateway";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const homeDir = await mkdtemp(join(tmpdir(), "clanky-mcp-swarm-"));
const previousEnv = captureEnv(
	"CLANKY_SWARM_ENABLED",
	"CLANKY_SWARM_COMMAND",
	"CLANKY_SWARM_ARGS_JSON",
	"AGENT_IDENTITY",
);
process.env.CLANKY_SWARM_ENABLED = "1";
process.env.CLANKY_SWARM_COMMAND = process.execPath;
process.env.CLANKY_SWARM_ARGS_JSON = JSON.stringify([
	"--import",
	"tsx",
	"packages/clanky-swarm/test/faux-swarm-mcp.ts",
]);
process.env.AGENT_IDENTITY = "mcp-smoke";

const server = await startGatewayServer({ homeDir });
const transport = new StdioClientTransport({
	command: tsxBinary(),
	args: ["packages/clanky-cli/src/bin.ts", "mcp", "--home", homeDir],
	cwd: process.cwd(),
	env: getDefaultEnvironment(),
	stderr: "pipe",
});
const stderrChunks: string[] = [];
transport.stderr?.on("data", (chunk) => {
	stderrChunks.push(String(chunk));
});
const client = new Client({ name: "clanky-mcp-swarm-smoke", version: "0.0.0" });
const watchdog = setTimeout(() => {
	console.error("Timed out in mcp swarm smoke");
	process.exit(1);
}, 15_000);

try {
	await client.connect(transport);
	const status = resultRecord(await client.callTool({ name: "swarm.status", arguments: {} }));
	if (status.state !== "booted" || status.instanceId !== "clanky-faux-gateway" || status.identity !== "mcp-smoke") {
		throw new Error(`MCP swarm.status returned unexpected result: ${JSON.stringify(status)}`);
	}
	const peers = resultRecord(await client.callTool({ name: "swarm.peers", arguments: {} }));
	if (peers.ok !== true || !hasSwarmItem(arrayProperty(peers, "data"), "clanky-faux-worker")) {
		throw new Error(`MCP swarm.peers returned unexpected result: ${JSON.stringify(peers)}`);
	}
	const tasks = resultRecord(await client.callTool({ name: "swarm.tasks", arguments: {} }));
	if (tasks.ok !== true || !hasSwarmItem(arrayProperty(tasks, "data"), "task-1")) {
		throw new Error(`MCP swarm.tasks returned unexpected result: ${JSON.stringify(tasks)}`);
	}
	const snapshot = resultRecord(await client.callTool({ name: "swarm.snapshot", arguments: {} }));
	if (
		snapshot.ok !== true ||
		!hasSwarmItem(arrayProperty(snapshot, "instances"), "clanky-faux-gateway") ||
		!hasSwarmItem(arrayProperty(snapshot, "tasks"), "task-1")
	) {
		throw new Error(`MCP swarm.snapshot returned unexpected result: ${JSON.stringify(snapshot)}`);
	}
	const message = resultRecord(
		await client.callTool({
			name: "swarm.message",
			arguments: {
				recipient: "clanky-faux-worker",
				message: "MCP swarm smoke message.",
				task_id: "task-1",
				nudge: false,
				force: true,
			},
		}),
	);
	const messageRequest = property(message, "request");
	if (
		message.ok !== true ||
		!isRecord(messageRequest) ||
		messageRequest.recipient !== "clanky-faux-worker" ||
		messageRequest.taskId !== "task-1" ||
		messageRequest.nudge !== false ||
		messageRequest.force !== true
	) {
		throw new Error(`MCP swarm.message returned unexpected result: ${JSON.stringify(message)}`);
	}

	const dispatch = resultRecord(
		await client.callTool({
			name: "swarm.dispatch",
			arguments: {
				title: "MCP faux dispatch",
				type: "implement",
				description: "Exercise Clanky MCP swarm dispatch.",
				files: ["README.md"],
				provider: "anthropic",
				model: "claude-opus-4-5",
				linear_issue: "PROJ-123",
				idempotency_key: "mcp-swarm-smoke-1",
			},
		}),
	);
	if (dispatch.ok !== true || dispatch.taskId !== "task-1" || dispatch.dispatchStatus !== "dispatched") {
		throw new Error(`MCP swarm.dispatch returned unexpected result: ${JSON.stringify(dispatch)}`);
	}
	if (!JSON.stringify(dispatch).includes("claude-opus-4-5")) {
		throw new Error(`MCP swarm.dispatch did not preserve model override: ${JSON.stringify(dispatch)}`);
	}
	const duplicateDispatch = resultRecord(
		await client.callTool({
			name: "swarm.dispatch",
			arguments: {
				title: "MCP faux dispatch duplicate",
				type: "implement",
				description: "Exercise Clanky MCP swarm dispatch idempotency.",
				files: ["README.md"],
				linear_issue: "PROJ-123",
				idempotency_key: "mcp-swarm-smoke-1",
			},
		}),
	);
	const duplicateResponse = property(duplicateDispatch, "response");
	if (
		duplicateDispatch.ok !== true ||
		duplicateDispatch.taskId !== "task-1" ||
		duplicateDispatch.dispatchStatus !== "dispatched" ||
		property(duplicateResponse, "deduplicated") !== true
	) {
		throw new Error(`MCP swarm.dispatch did not preserve idempotency: ${JSON.stringify(duplicateDispatch)}`);
	}

	const linear = resultRecord(await client.callTool({ name: "linear.list", arguments: {} }));
	const links = arrayProperty(linear, "links");
	const [link] = links;
	if (!isRecord(link) || link.issueId !== "PROJ-123" || link.taskId !== "task-1") {
		throw new Error(`MCP swarm.dispatch did not persist a Linear task link: ${JSON.stringify(linear)}`);
	}

	const lock = resultRecord(
		await client.callTool({
			name: "swarm.file_lock",
			arguments: { path: "locked-file.ts" },
		}),
	);
	if (lock.ok !== true || lock.blocked !== true || lock.ownerId !== "clanky-faux-worker") {
		throw new Error(`MCP swarm.file_lock did not return a blocking peer lock: ${JSON.stringify(lock)}`);
	}

	const complete = resultRecord(
		await client.callTool({
			name: "swarm.complete",
			arguments: {
				task_id: "task-1",
				summary: "Completed through MCP.",
				files_changed: ["README.md"],
				tests: [{ command: "pnpm check", status: "passed" }],
				tracker_update_skipped: { reason: "MCP snake_case tracker alias smoke." },
			},
		}),
	);
	if (complete.ok !== true) {
		throw new Error(`MCP swarm.complete failed: ${JSON.stringify(complete)}`);
	}
	const request = property(complete, "request");
	const trackerUpdateSkipped = property(request, "trackerUpdateSkipped");
	if (!isRecord(trackerUpdateSkipped) || trackerUpdateSkipped.reason !== "MCP snake_case tracker alias smoke.") {
		throw new Error(`MCP swarm.complete did not normalize tracker_update_skipped: ${JSON.stringify(complete)}`);
	}
	const outboxEntries = arrayProperty(complete, "linearOutboxEntries");
	const [entry] = outboxEntries;
	if (!isRecord(entry) || entry.issueId !== "PROJ-123" || entry.taskId !== "task-1" || entry.status !== "pending") {
		throw new Error(`MCP swarm.complete did not mirror completion to Linear outbox: ${JSON.stringify(complete)}`);
	}
	if (typeof entry.body !== "string" || !entry.body.includes("Tracker update skipped:")) {
		throw new Error(`MCP swarm.complete did not mirror the tracker skip into Linear: ${JSON.stringify(complete)}`);
	}
	if (!entry.body.includes("MCP snake_case tracker alias smoke.")) {
		throw new Error(`MCP swarm.complete did not mirror the provided tracker skip: ${JSON.stringify(complete)}`);
	}

	console.log(
		JSON.stringify({
			taskId: dispatch.taskId,
			status: status.state,
			links: links.length,
			outbox: outboxEntries.length,
			deduplicated: property(duplicateResponse, "deduplicated"),
			lockBlocked: lock.blocked,
		}),
	);
} catch (error) {
	const stderr = stderrChunks.join("").trim();
	if (stderr.length > 0) console.error(stderr);
	throw error;
} finally {
	clearTimeout(watchdog);
	await client.close();
	await server.close();
	restoreEnv(previousEnv);
	await rm(homeDir, { force: true, recursive: true });
}

function tsxBinary(): string {
	const name = process.platform === "win32" ? "tsx.cmd" : "tsx";
	return join(process.cwd(), "node_modules", ".bin", name);
}

function resultRecord(value: unknown): Record<string, unknown> {
	const parsed = resultJson(value);
	if (!isRecord(parsed)) throw new Error(`Expected object result: ${JSON.stringify(value)}`);
	return parsed;
}

function resultJson(value: unknown): unknown {
	const structuredContent = property(value, "structuredContent");
	if (structuredContent !== undefined) return structuredContent;
	const content = property(value, "content");
	if (!Array.isArray(content)) return value;
	const first = content[0];
	const text = property(first, "text");
	if (typeof text !== "string") return value;
	try {
		return JSON.parse(text) as unknown;
	} catch {
		return value;
	}
}

function arrayProperty(value: Record<string, unknown>, key: string): unknown[] {
	const item = value[key];
	if (!Array.isArray(item)) throw new Error(`Expected ${key} array: ${JSON.stringify(value)}`);
	return item;
}

function hasSwarmItem(items: unknown[], id: string): boolean {
	return items.some((item) => isRecord(item) && (item.id === id || item.instance_id === id || item.task_id === id));
}

function property(value: unknown, key: string): unknown {
	if (!isRecord(value)) return undefined;
	return value[key];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function captureEnv(...keys: string[]): Map<string, string | undefined> {
	const values = new Map<string, string | undefined>();
	for (const key of keys) values.set(key, process.env[key]);
	return values;
}

function restoreEnv(values: Map<string, string | undefined>): void {
	for (const [key, value] of values) {
		if (value === undefined) {
			delete process.env[key];
		} else {
			process.env[key] = value;
		}
	}
}
