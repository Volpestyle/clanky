import { readFileSync, writeFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { type ZodRawShape, z } from "zod/v4";

const instanceId = "clanky-faux-gateway";
const workerId = "clanky-faux-worker";
const directory = process.env.SWARM_MCP_DIRECTORY ?? process.cwd();
const scope = process.env.SWARM_MCP_SCOPE ?? directory;
const label = process.env.SWARM_MCP_LABEL ?? "clanky mode:gateway role:planner identity:test";
const calls: string[] = [];
const dispatchesByIdempotencyKey = new Map<string, string>();
const dispatchedTasks = new Map<string, Record<string, unknown>>();
const kv = new Map<string, string>();
let activitySent = false;
let nextTaskNumber = 1;

loadState();

const server = new McpServer({ name: "faux-swarm-mcp", version: "0.0.0" });

registerJsonTool(
	"register",
	{
		directory: z.string().optional(),
		label: z.string().optional(),
		scope: z.string().optional(),
		file_root: z.string().optional(),
	},
	(args) => {
		recordCall("register");
		return { ok: true, registered: true, args };
	},
);

registerJsonTool("whoami", {}, () => {
	recordCall("whoami");
	return {
		id: instanceId,
		instance_id: instanceId,
		directory,
		scope,
		label,
	};
});

registerJsonTool("bootstrap", {}, () => {
	recordCall("bootstrap");
	return { ok: true, peers: peers(), tasks: tasks() };
});

registerJsonTool("list_instances", {}, () => {
	recordCall("list_instances");
	return peers();
});

registerJsonTool("list_tasks", {}, () => {
	recordCall("list_tasks");
	return tasks();
});

registerJsonTool("swarm_status", {}, () => {
	recordCall("swarm_status");
	return {
		ok: true,
		instances: 2,
		tasks: 1,
		held_locks: [{ file: "owned-file.ts", instance_id: instanceId }],
		blocking_locks: [{ file: "locked-file.ts", instance_id: workerId }],
		warnings: [],
		calls,
		kv: Object.fromEntries(kv),
		env: {
			AGENT_IDENTITY: process.env.AGENT_IDENTITY,
			SWARM_DB_PATH: process.env.SWARM_DB_PATH,
			SWARM_MCP_DIRECTORY: process.env.SWARM_MCP_DIRECTORY,
			SWARM_MCP_SCOPE: process.env.SWARM_MCP_SCOPE,
			SWARM_MCP_FILE_ROOT: process.env.SWARM_MCP_FILE_ROOT,
			HERDR_PANE_ID: process.env.HERDR_PANE_ID,
			HERDR_SOCKET_PATH: process.env.HERDR_SOCKET_PATH,
			SWARM_HERDR_BIN: process.env.SWARM_HERDR_BIN,
			SWARM_HERDR_PARENT_PANE: process.env.SWARM_HERDR_PARENT_PANE,
			SWARM_HARNESS_CODEX: process.env.SWARM_HARNESS_CODEX,
			SWARM_WORKER_HARNESS: process.env.SWARM_WORKER_HARNESS,
		},
	};
});

registerJsonTool(
	"kv_set",
	{
		key: z.string(),
		value: z.string(),
	},
	(args) => {
		recordCall("kv_set");
		const key = stringProperty(args, "key");
		const value = stringProperty(args, "value");
		if (key !== undefined && value !== undefined) kv.set(key, value);
		return { ok: true, args };
	},
);

registerJsonTool("wait_for_activity", {}, async () => {
	recordCall("wait_for_activity");
	await delay(50);
	if (activitySent) return { timeout: true };
	activitySent = true;
	return { changes: ["task.changed", "kv_updates"], task_id: "task-1" };
});

registerJsonTool("get_file_lock", { file: z.string() }, (args) => {
	recordCall("get_file_lock");
	const file = stringProperty(args, "file") ?? "unknown";
	if (file.includes("locked")) {
		return {
			file,
			active: {
				instance_id: workerId,
				owner: {
					id: workerId,
					label: "worker role:implementer",
				},
			},
		};
	}
	return { file, active: null };
});

registerJsonTool(
	"dispatch",
	{
		title: z.string().optional(),
		message: z.string().optional(),
		type: z.string().optional(),
		role: z.string().optional(),
		files: z.array(z.string()).optional(),
		spawn: z.boolean().optional(),
		idempotency_key: z.string().optional(),
		completion_wait_seconds: z.number().optional(),
		promote_identifier: z.string().optional(),
	},
	(args) => {
		recordCall("dispatch");
		const idempotencyKey = stringProperty(args, "idempotency_key");
		const existingTaskId = idempotencyKey === undefined ? undefined : dispatchesByIdempotencyKey.get(idempotencyKey);
		const status = dispatchStatus(args, existingTaskId);
		if (existingTaskId !== undefined) {
			return {
				ok: true,
				task_id: existingTaskId,
				status,
				message: `Reused ${existingTaskId} for ${idempotencyKey}`,
				deduplicated: true,
				args,
			};
		}
		const taskId = `task-${nextTaskNumber}`;
		nextTaskNumber += 1;
		if (idempotencyKey !== undefined) dispatchesByIdempotencyKey.set(idempotencyKey, taskId);
		if (idempotencyKey === "swarm-smoke-fast-complete") {
			dispatchedTasks.set(taskId, {
				id: taskId,
				task_id: taskId,
				title: stringProperty(args, "title") ?? "Fast completed task",
				status: "done",
				idempotency_key: idempotencyKey,
			});
			saveState();
			return {
				task_id: taskId,
				status: "spawn_failed",
				error: "dispatch task binding failed: Task is already done",
				failure: "task_binding_failed",
				binding: { error: "Task is already done" },
				args,
			};
		}
		if (idempotencyKey === "swarm-smoke-fast-claim") {
			dispatchedTasks.set(taskId, {
				id: taskId,
				task_id: taskId,
				title: stringProperty(args, "title") ?? "Fast claimed task",
				status: "in_progress",
				idempotency_key: idempotencyKey,
			});
			saveState();
			return {
				task_id: taskId,
				status: "spawn_failed",
				error: "dispatch task binding failed: Task is already in_progress",
				failure: "task_binding_failed",
				binding: { error: "Task is already in_progress" },
				args,
			};
		}
		dispatchedTasks.set(taskId, {
			id: taskId,
			task_id: taskId,
			title: stringProperty(args, "title") ?? "Dispatched faux task",
			status,
			...(idempotencyKey === undefined ? {} : { idempotency_key: idempotencyKey }),
		});
		saveState();
		return {
			ok: true,
			task_id: taskId,
			status,
			message: `Dispatched ${stringProperty(args, "title") ?? "task"}`,
			deduplicated: false,
			args,
		};
	},
);

registerJsonTool(
	"prompt_peer",
	{
		recipient: z.string().optional(),
		message: z.string().optional(),
		task_id: z.string().optional(),
		nudge: z.boolean().optional(),
		force: z.boolean().optional(),
	},
	(args) => {
		recordCall("prompt_peer");
		return {
			ok: true,
			message: `Prompted ${stringProperty(args, "recipient") ?? "peer"}`,
			args,
		};
	},
);

registerJsonTool(
	"complete_task",
	{
		task_id: z.string().optional(),
		status: z.string().optional(),
		summary: z.string().optional(),
		files_changed: z.array(z.string()).optional(),
		tests: z.array(z.record(z.string(), z.unknown())).optional(),
		tracker_update: z.unknown().optional(),
		tracker_update_skipped: z.unknown().optional(),
		followups: z.array(z.string()).optional(),
	},
	(args) => {
		recordCall("complete_task");
		return {
			ok: true,
			message: `Completed ${stringProperty(args, "task_id") ?? "task"}`,
			args,
		};
	},
);

registerJsonTool("deregister", {}, () => {
	recordCall("deregister");
	return { ok: true };
});

await server.connect(new StdioServerTransport());

function registerJsonTool(
	name: string,
	inputSchema: ZodRawShape,
	handler: (args: Record<string, unknown>) => unknown | Promise<unknown>,
): void {
	server.registerTool(name, { inputSchema }, async (args) => jsonToolResult(await handler(args)));
}

function jsonToolResult(value: unknown): CallToolResult {
	return {
		content: [
			{
				type: "text",
				text: JSON.stringify(value),
			},
		],
	};
}

function peers(): Array<Record<string, string>> {
	return [
		{ id: instanceId, instance_id: instanceId, label, directory, scope },
		{ id: workerId, instance_id: workerId, label: "worker role:implementer", directory, scope },
	];
}

function tasks(): Array<Record<string, unknown>> {
	const defaultTask = { id: "task-1", task_id: "task-1", title: "Faux task", status: "claimed" };
	return dispatchedTasks.has("task-1") ? [...dispatchedTasks.values()] : [defaultTask, ...dispatchedTasks.values()];
}

function recordCall(name: string): void {
	calls.push(name);
	const callsFile =
		process.env.SWARM_HARNESS_FAUX_SWARM_CALLS_FILE?.trim() ?? process.env.CLANKY_FAUX_SWARM_CALLS_FILE?.trim();
	if (callsFile !== undefined && callsFile.length > 0) writeFileSync(callsFile, `${calls.join("\n")}\n`);
}

function stringProperty(value: Record<string, unknown>, key: string): string | undefined {
	const item = value[key];
	return typeof item === "string" && item.trim().length > 0 ? item : undefined;
}

function dispatchStatus(args: Record<string, unknown>, existingTaskId: string | undefined): string {
	if (existingTaskId !== undefined) {
		const status = stringProperty(dispatchedTasks.get(existingTaskId) ?? {}, "status");
		if (status !== undefined) return status;
	}
	return args.spawn === false ? "no_worker" : "dispatched";
}

function stateFile(): string | undefined {
	const value = process.env.SWARM_HARNESS_FAUX_SWARM_STATE_FILE?.trim();
	return value === undefined || value.length === 0 ? undefined : value;
}

function loadState(): void {
	const file = stateFile();
	if (file === undefined) return;
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
	} catch {
		return;
	}
	if (!isRecord(parsed)) return;
	if (
		typeof parsed.nextTaskNumber === "number" &&
		Number.isInteger(parsed.nextTaskNumber) &&
		parsed.nextTaskNumber > 0
	) {
		nextTaskNumber = parsed.nextTaskNumber;
	}
	const dispatches = recordProperty(parsed, "dispatchesByIdempotencyKey");
	for (const [key, value] of Object.entries(dispatches ?? {})) {
		if (typeof value === "string") dispatchesByIdempotencyKey.set(key, value);
	}
	const tasksById = recordProperty(parsed, "dispatchedTasks");
	for (const [key, value] of Object.entries(tasksById ?? {})) {
		if (!isRecord(value)) continue;
		dispatchedTasks.set(key, value);
	}
}

function saveState(): void {
	const file = stateFile();
	if (file === undefined) return;
	writeFileSync(
		file,
		`${JSON.stringify(
			{
				nextTaskNumber,
				dispatchesByIdempotencyKey: Object.fromEntries(dispatchesByIdempotencyKey),
				dispatchedTasks: Object.fromEntries(dispatchedTasks),
			},
			null,
			2,
		)}\n`,
	);
}

function recordProperty(value: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
	const item = value[key];
	return isRecord(item) ? item : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
