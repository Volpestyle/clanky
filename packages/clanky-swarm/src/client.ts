import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { SwarmCompleteRequest } from "./complete.ts";
import type { SwarmDispatchRequest, SwarmDispatchType } from "./dispatch.ts";

export interface SwarmMcpClientOptions {
	command: string;
	args: string[];
	cwd: string;
	profile: string;
	identity: string;
	databasePath: string;
	childEnv?: Record<string, string>;
}

export interface SwarmRegistration {
	instanceId: string;
	scope: string;
	directory: string;
	label: string;
}

export interface SwarmMcpDispatchResult {
	ok: boolean;
	message: string;
	payload: unknown;
	taskId?: string;
	dispatchStatus?: string;
}

export interface SwarmMcpFileLockPayload {
	file: string;
	active: unknown;
}

export interface SwarmMcpPromptPeerOptions {
	taskId?: string;
	nudge: boolean;
	force: boolean;
}

export interface SwarmMcpPromptPeerResult {
	ok: boolean;
	message: string;
	payload: unknown;
}

export interface SwarmMcpCompleteTaskResult {
	ok: boolean;
	message: string;
	payload: unknown;
}

export class SwarmMcpClient {
	private readonly client: Client;
	private readonly options: SwarmMcpClientOptions;
	private transport: StdioClientTransport | undefined;

	constructor(options: SwarmMcpClientOptions) {
		this.options = options;
		this.client = new Client({ name: "clanky", version: "0.0.0" });
	}

	async start(): Promise<void> {
		if (this.transport !== undefined) return;
		const transport = new StdioClientTransport({
			command: this.options.command,
			args: this.options.args,
			cwd: this.options.cwd,
			env: childEnvironment(this.options),
			stderr: "pipe",
		});
		await this.client.connect(transport);
		this.transport = transport;
	}

	async register(): Promise<SwarmRegistration> {
		const label = `clanky mode:gateway role:planner identity:${this.options.identity}`;
		await this.callJsonTool("register", {
			directory: this.options.cwd,
			label,
			scope: this.options.cwd,
			file_root: this.options.cwd,
		});
		const whoami = await this.callJsonTool("whoami", {});
		const record = asRecord(whoami);
		const instanceId = stringProperty(record, "id") ?? stringProperty(record, "instance_id");
		if (instanceId === undefined) {
			throw new Error("swarm-mcp whoami did not return an instance id");
		}
		return {
			instanceId,
			scope: stringProperty(record, "scope") ?? this.options.cwd,
			directory: stringProperty(record, "directory") ?? this.options.cwd,
			label: stringProperty(record, "label") ?? label,
		};
	}

	async bootstrap(): Promise<unknown> {
		return await this.callJsonTool("bootstrap", {});
	}

	async listInstances(): Promise<unknown> {
		return await this.callJsonTool("list_instances", {});
	}

	async listTasks(): Promise<unknown> {
		return await this.callJsonTool("list_tasks", {});
	}

	async statusSummary(): Promise<unknown> {
		return await this.callJsonTool("swarm_status", {});
	}

	async kvSet(key: string, value: string): Promise<unknown> {
		return await this.callJsonTool("kv_set", { key, value });
	}

	async waitForActivity(timeoutSeconds: number): Promise<unknown> {
		return await this.callJsonTool("wait_for_activity", { timeout_seconds: timeoutSeconds });
	}

	async getFileLock(file: string): Promise<SwarmMcpFileLockPayload> {
		const payload = await this.callJsonTool("get_file_lock", { file });
		const record = asRecord(payload);
		return {
			file: stringProperty(record, "file") ?? file,
			active: property(payload, "active") ?? null,
		};
	}

	async promptPeer(
		recipient: string,
		message: string,
		options: SwarmMcpPromptPeerOptions,
	): Promise<SwarmMcpPromptPeerResult> {
		const payload = await this.callJsonTool("prompt_peer", {
			recipient,
			message,
			task_id: options.taskId,
			nudge: options.nudge,
			force: options.force,
		});
		const record = asRecord(payload);
		const error = stringProperty(record, "error");
		if (error !== undefined) return { ok: false, message: error, payload };
		return { ok: true, message: "Swarm peer prompted.", payload };
	}

	async completeTask(request: SwarmCompleteRequest): Promise<SwarmMcpCompleteTaskResult> {
		const payload = await this.callJsonTool("complete_task", {
			task_id: request.taskId,
			status: request.status,
			summary: request.summary,
			files_changed: request.filesChanged,
			tests: request.tests,
			tracker_update: request.trackerUpdate,
			tracker_update_skipped: request.trackerUpdateSkipped,
			followups: request.followups,
		});
		const record = asRecord(payload);
		const error = stringProperty(record, "error");
		if (error !== undefined) return { ok: false, message: error, payload };
		const message = stringProperty(record, "message") ?? `Swarm task ${request.taskId} completed.`;
		return { ok: true, message, payload };
	}

	async deregister(): Promise<void> {
		await this.callJsonTool("deregister", {});
	}

	async dispatch(request: SwarmDispatchRequest): Promise<SwarmMcpDispatchResult> {
		const payload = await this.callJsonTool("dispatch", {
			title: request.title,
			message: dispatchMessage(request),
			type: request.type,
			role: roleForDispatchType(request.type),
			files: request.files,
			spawn: request.spawn,
			idempotency_key: request.idempotencyKey,
			completion_wait_seconds: request.waitForCompletion ? 1800 : 0,
			placement: {
				workspace: "reuse_scope",
				split_direction: "right",
			},
			promote_identifier: request.linearIssue,
		});
		const record = asRecord(payload);
		const taskId = stringProperty(record, "task_id");
		const dispatchStatus = stringProperty(record, "status");
		const message = stringProperty(record, "message") ?? "Swarm task dispatched.";
		const error = stringProperty(record, "error");
		if (error !== undefined) {
			const recovered = await this.recoverDispatchBindingRace(error, payload, taskId, request.idempotencyKey);
			if (recovered !== undefined) return recovered;
			const result: SwarmMcpDispatchResult = { ok: false, message: error, payload };
			if (taskId !== undefined) result.taskId = taskId;
			if (dispatchStatus !== undefined) result.dispatchStatus = dispatchStatus;
			return result;
		}
		return dispatchResult(true, message, payload, taskId, dispatchStatus);
	}

	async close(): Promise<void> {
		await this.transport?.close();
		this.transport = undefined;
	}

	private async callJsonTool(name: string, args: Record<string, unknown>): Promise<unknown> {
		const result = await this.client.callTool({ name, arguments: withoutUndefined(args) });
		return resultJson(result);
	}

	private async recoverDispatchBindingRace(
		error: string,
		payload: unknown,
		taskId: string | undefined,
		idempotencyKey: string | undefined,
	): Promise<SwarmMcpDispatchResult | undefined> {
		if (!isTerminalBindingRace(error)) return undefined;
		const task = findDispatchTask(await this.listTasks(), taskId, idempotencyKey);
		if (task === undefined) return undefined;
		const status = taskStatus(task);
		if (status === undefined || !isHandoffAcceptedTaskStatus(status)) return undefined;
		const recoveredTaskId = taskId ?? taskIdentifier(task);
		const recoveredPayload = {
			...asRecord(payload),
			task,
			recovered: true,
			recovery_error: error,
		};
		return dispatchResult(
			true,
			`Swarm task is ${status} before dispatch handoff finished.`,
			recoveredPayload,
			recoveredTaskId,
			status,
		);
	}
}

function dispatchMessage(request: SwarmDispatchRequest): string {
	if (request.provider === undefined && request.model === undefined) return request.description;
	const lines = ["Clanky model override requested for this dispatched task:"];
	if (request.provider !== undefined) lines.push(`provider: ${request.provider}`);
	if (request.model !== undefined) lines.push(`model: ${request.model}`);
	lines.push("", request.description);
	return lines.join("\n");
}

function childEnvironment(options: SwarmMcpClientOptions): Record<string, string> {
	return {
		...getDefaultEnvironment(),
		AGENT_IDENTITY: options.identity,
		...options.childEnv,
		SWARM_DB_PATH: options.databasePath,
		SWARM_MCP_DIRECTORY: options.cwd,
		SWARM_MCP_SCOPE: options.cwd,
		SWARM_MCP_FILE_ROOT: options.cwd,
		SWARM_MCP_LABEL: `clanky mode:gateway role:planner identity:${options.identity}`,
	};
}

function roleForDispatchType(type: SwarmDispatchType): string {
	if (type === "review") return "reviewer";
	if (type === "research") return "researcher";
	return "implementer";
}

function dispatchResult(
	ok: boolean,
	message: string,
	payload: unknown,
	taskId: string | undefined,
	dispatchStatus: string | undefined,
): SwarmMcpDispatchResult {
	const result: SwarmMcpDispatchResult = { ok, message, payload };
	if (taskId !== undefined) result.taskId = taskId;
	if (dispatchStatus !== undefined) result.dispatchStatus = dispatchStatus;
	return result;
}

function isTerminalBindingRace(error: string): boolean {
	return error.startsWith("dispatch task binding failed: Task is already ");
}

function findDispatchTask(
	payload: unknown,
	taskId: string | undefined,
	idempotencyKey: string | undefined,
): Record<string, unknown> | undefined {
	for (const task of taskRows(payload)) {
		if (taskId !== undefined && taskIdentifier(task) === taskId) return task;
		if (idempotencyKey !== undefined && stringProperty(task, "idempotency_key") === idempotencyKey) return task;
	}
	return undefined;
}

function taskRows(value: unknown): Record<string, unknown>[] {
	if (Array.isArray(value)) return value.filter(isRecord);
	const record = asRecord(value);
	const data = record.data;
	if (Array.isArray(data)) return data.filter(isRecord);
	const tasks = record.tasks;
	if (Array.isArray(tasks)) return tasks.filter(isRecord);
	return [];
}

function taskIdentifier(task: Record<string, unknown>): string | undefined {
	return stringProperty(task, "id") ?? stringProperty(task, "task_id");
}

function taskStatus(task: Record<string, unknown>): string | undefined {
	return stringProperty(task, "status");
}

function isHandoffAcceptedTaskStatus(status: string): boolean {
	return (
		status === "claimed" ||
		status === "in_progress" ||
		status === "done" ||
		status === "failed" ||
		status === "cancelled"
	);
}

function withoutUndefined(values: Record<string, unknown>): Record<string, unknown> {
	const result: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(values)) {
		if (value !== undefined) result[key] = value;
	}
	return result;
}

function resultJson(value: unknown): unknown {
	const structuredContent = property(value, "structuredContent");
	if (structuredContent !== undefined) return structuredContent;
	const content = property(value, "content");
	if (!Array.isArray(content)) return value;
	const first = content[0];
	const text = typeof first === "object" && first !== null && "text" in first ? first.text : undefined;
	if (typeof text !== "string") return value;
	try {
		return JSON.parse(text) as unknown;
	} catch {
		return { text };
	}
}

function asRecord(value: unknown): Record<string, unknown> {
	if (typeof value === "object" && value !== null && !Array.isArray(value)) return value as Record<string, unknown>;
	return {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function property(value: unknown, key: string): unknown {
	return asRecord(value)[key];
}

function stringProperty(value: Record<string, unknown>, key: string): string | undefined {
	const item = value[key];
	return typeof item === "string" && item.trim().length > 0 ? item : undefined;
}
