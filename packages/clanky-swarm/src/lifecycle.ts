import { join } from "node:path";
import { SwarmMcpClient } from "./client.ts";
import type { SwarmCompleteInput, SwarmCompleteResult } from "./complete.ts";
import { normalizeSwarmCompleteInput } from "./complete.ts";
import type { SwarmDispatchInput, SwarmDispatchResult } from "./dispatch.ts";
import { normalizeSwarmDispatchInput } from "./dispatch.ts";
import type { SwarmLeaderEvent, SwarmLeaderEventListener } from "./events.ts";
import { decideSwarmFileLock } from "./lock-hook.ts";
import type { SwarmMessageInput, SwarmMessageResult } from "./message.ts";
import { normalizeSwarmMessageInput } from "./message.ts";
import { isSwarmTimeoutActivity, swarmActivityChanges } from "./poller.ts";
import type { SwarmQueryResult, SwarmSnapshotResult } from "./snapshot.ts";

export type SwarmLeaderState = "disabled" | "missing_command" | "configured" | "booted" | "error";

export interface SwarmLeaderOptions {
	profile: string;
	profileDir: string;
	cwd?: string;
	env?: NodeJS.ProcessEnv;
}

export interface SwarmLeaderStatus {
	enabled: boolean;
	state: SwarmLeaderState;
	profile: string;
	profileDir: string;
	identity: string;
	cwd: string;
	databasePath: string;
	args: string[];
	message: string;
	command?: string;
	instanceId?: string;
	bootedAt?: string;
	scope?: string;
	label?: string;
	workspaceHandle?: HerdrWorkspaceHandle;
	error?: string;
}

export interface SwarmFileLockResult {
	ok: boolean;
	state: SwarmLeaderState;
	message: string;
	status: SwarmLeaderStatus;
	file: string;
	active: unknown;
	blocked: boolean;
	ownerId?: string;
	ownerLabel?: string;
	reason?: string;
}

export interface SwarmCronDeliveryResult {
	ok: boolean;
	state: SwarmLeaderState;
	message: string;
	status: SwarmLeaderStatus;
	target: string;
	response?: unknown;
}

interface SwarmLeaderConfig {
	enabled: boolean;
	profile: string;
	profileDir: string;
	identity: string;
	cwd: string;
	databasePath: string;
	args: string[];
	childEnv: Record<string, string>;
	command?: string;
	workspaceHandle?: HerdrWorkspaceHandle;
}

interface HerdrWorkspaceHandle {
	backend: "herdr";
	handle_kind: "pane";
	handle: string;
	socket_path?: string;
}

export class SwarmLeader {
	private readonly config: SwarmLeaderConfig;
	private bootedAt: string | undefined;
	private instanceId: string | undefined;
	private scope: string | undefined;
	private label: string | undefined;
	private lastError: string | undefined;
	private client: SwarmMcpClient | undefined;
	private polling = false;
	private poller: Promise<void> | undefined;
	private readonly listeners = new Set<SwarmLeaderEventListener>();

	constructor(options: SwarmLeaderOptions) {
		this.config = readSwarmLeaderConfig(options);
	}

	status(): SwarmLeaderStatus {
		const base = {
			enabled: this.config.enabled,
			profile: this.config.profile,
			profileDir: this.config.profileDir,
			identity: this.config.identity,
			cwd: this.config.cwd,
			databasePath: this.config.databasePath,
			args: this.config.args,
			...(this.config.workspaceHandle === undefined ? {} : { workspaceHandle: this.config.workspaceHandle }),
		};
		if (this.lastError !== undefined) {
			return {
				...base,
				state: "error",
				message: "Swarm leader boot failed.",
				...(this.config.command === undefined ? {} : { command: this.config.command }),
				error: this.lastError,
			};
		}
		if (!this.config.enabled) {
			return {
				...base,
				state: "disabled",
				message: "Set CLANKY_SWARM_ENABLED=1 and CLANKY_SWARM_COMMAND before booting swarm-mcp.",
				...(this.config.command === undefined ? {} : { command: this.config.command }),
			};
		}
		if (this.config.command === undefined) {
			return {
				...base,
				state: "missing_command",
				message: "CLANKY_SWARM_COMMAND is required before booting swarm-mcp.",
			};
		}
		if (this.instanceId !== undefined && this.bootedAt !== undefined) {
			return {
				...base,
				state: "booted",
				message: "Swarm leader is booted.",
				command: this.config.command,
				instanceId: this.instanceId,
				bootedAt: this.bootedAt,
				...(this.scope === undefined ? {} : { scope: this.scope }),
				...(this.label === undefined ? {} : { label: this.label }),
			};
		}
		return {
			...base,
			state: "configured",
			message: "Swarm leader is configured but not booted.",
			command: this.config.command,
		};
	}

	subscribe(listener: SwarmLeaderEventListener): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	async start(): Promise<void> {
		this.lastError = undefined;
		if (!this.config.enabled || this.config.command === undefined) return;
		const client = new SwarmMcpClient({
			command: this.config.command,
			args: this.config.args,
			cwd: this.config.cwd,
			profile: this.config.profile,
			identity: this.config.identity,
			databasePath: this.config.databasePath,
			childEnv: this.config.childEnv,
		});
		try {
			await client.start();
			const registration = await client.register();
			await client.bootstrap();
			await this.publishWorkspaceHandle(client, registration.instanceId);
			this.client = client;
			this.instanceId = registration.instanceId;
			this.scope = registration.scope;
			this.label = registration.label;
			this.bootedAt = new Date().toISOString();
			this.publish({
				type: "swarm.booted",
				instanceId: registration.instanceId,
				scope: registration.scope,
				label: registration.label,
			});
			this.startPoller(client);
		} catch (error) {
			this.lastError = error instanceof Error ? error.message : String(error);
			this.publish({ type: "swarm.error", error: this.lastError });
			await client.close().catch(() => undefined);
		}
	}

	async close(): Promise<void> {
		this.polling = false;
		await this.client?.deregister().catch(() => undefined);
		await this.client?.close();
		await this.poller?.catch(() => undefined);
		this.client = undefined;
		this.bootedAt = undefined;
		this.instanceId = undefined;
		this.scope = undefined;
		this.label = undefined;
	}

	async dispatch(input: SwarmDispatchInput): Promise<SwarmDispatchResult> {
		const request = normalizeSwarmDispatchInput(input);
		const status = this.status();
		if (status.state !== "booted" || this.client === undefined) {
			return {
				ok: false,
				state: status.state,
				message: `Cannot dispatch swarm task "${request.title}" because swarm leader is ${status.state}. ${status.message}`,
				status,
				request,
			};
		}
		try {
			const result = await this.client.dispatch(request);
			const nextStatus = this.status();
			const dispatchResult: SwarmDispatchResult = {
				ok: result.ok,
				state: nextStatus.state,
				message: result.message,
				status: nextStatus,
				request,
				response: result.payload,
			};
			if (result.taskId !== undefined) dispatchResult.taskId = result.taskId;
			if (result.dispatchStatus !== undefined) dispatchResult.dispatchStatus = result.dispatchStatus;
			return dispatchResult;
		} catch (error) {
			this.lastError = error instanceof Error ? error.message : String(error);
			const errorStatus = this.status();
			return {
				ok: false,
				state: errorStatus.state,
				message: this.lastError,
				status: errorStatus,
				request,
			};
		}
	}

	async listInstances(): Promise<SwarmQueryResult> {
		const status = this.status();
		if (status.state !== "booted" || this.client === undefined) return notBootedQueryResult(status, "instances");
		return {
			ok: true,
			state: status.state,
			message: "Swarm instances loaded.",
			status,
			data: await this.client.listInstances(),
		};
	}

	async listTasks(): Promise<SwarmQueryResult> {
		const status = this.status();
		if (status.state !== "booted" || this.client === undefined) return notBootedQueryResult(status, "tasks");
		return {
			ok: true,
			state: status.state,
			message: "Swarm tasks loaded.",
			status,
			data: await this.client.listTasks(),
		};
	}

	async getFileLock(file: string): Promise<SwarmFileLockResult> {
		const status = this.status();
		if (status.state !== "booted" || this.client === undefined) {
			return {
				ok: false,
				state: status.state,
				message: `Cannot inspect swarm file lock because swarm leader is ${status.state}. ${status.message}`,
				status,
				file,
				active: null,
				blocked: false,
			};
		}
		try {
			const payload = await this.client.getFileLock(file);
			const decision = decideSwarmFileLock(payload.file, payload.active, status.instanceId);
			const result: SwarmFileLockResult = {
				ok: true,
				state: status.state,
				message: decision.blocked
					? "Swarm file lock is held by another peer."
					: "Swarm file lock does not block edits.",
				status,
				file: payload.file,
				active: payload.active,
				blocked: decision.blocked,
			};
			if (decision.ownerId !== undefined) result.ownerId = decision.ownerId;
			if (decision.ownerLabel !== undefined) result.ownerLabel = decision.ownerLabel;
			if (decision.reason !== undefined) result.reason = decision.reason;
			return result;
		} catch (error) {
			this.lastError = error instanceof Error ? error.message : String(error);
			const errorStatus = this.status();
			return {
				ok: false,
				state: errorStatus.state,
				message: this.lastError,
				status: errorStatus,
				file,
				active: null,
				blocked: true,
				reason: `Swarm file lock check failed for ${file}: ${this.lastError}`,
			};
		}
	}

	async deliverCronOutput(target: string, message: string): Promise<SwarmCronDeliveryResult> {
		const status = this.status();
		if (status.state !== "booted" || this.client === undefined) {
			return {
				ok: false,
				state: status.state,
				message: `Cannot deliver cron output to swarm peer "${target}" because swarm leader is ${status.state}. ${status.message}`,
				status,
				target,
			};
		}
		try {
			const result = await this.client.promptPeer(target, message, { nudge: true, force: false });
			const deliveryResult: SwarmCronDeliveryResult = {
				ok: result.ok,
				state: status.state,
				message: result.message,
				status,
				target,
				response: result.payload,
			};
			return deliveryResult;
		} catch (error) {
			this.lastError = error instanceof Error ? error.message : String(error);
			const errorStatus = this.status();
			return {
				ok: false,
				state: errorStatus.state,
				message: this.lastError,
				status: errorStatus,
				target,
			};
		}
	}

	async message(input: SwarmMessageInput): Promise<SwarmMessageResult> {
		const request = normalizeSwarmMessageInput(input);
		const status = this.status();
		if (status.state !== "booted" || this.client === undefined) {
			return {
				ok: false,
				state: status.state,
				message: `Cannot message swarm peer "${request.recipient}" because swarm leader is ${status.state}. ${status.message}`,
				status,
				request,
			};
		}
		try {
			const promptOptions: Parameters<SwarmMcpClient["promptPeer"]>[2] = {
				nudge: request.nudge,
				force: request.force,
			};
			if (request.taskId !== undefined) promptOptions.taskId = request.taskId;
			const result = await this.client.promptPeer(request.recipient, request.message, promptOptions);
			const messageResult: SwarmMessageResult = {
				ok: result.ok,
				state: status.state,
				message: result.message,
				status,
				request,
				response: result.payload,
			};
			return messageResult;
		} catch (error) {
			this.lastError = error instanceof Error ? error.message : String(error);
			const errorStatus = this.status();
			return {
				ok: false,
				state: errorStatus.state,
				message: this.lastError,
				status: errorStatus,
				request,
			};
		}
	}

	async complete(input: SwarmCompleteInput): Promise<SwarmCompleteResult> {
		const request = normalizeSwarmCompleteInput(input);
		const status = this.status();
		if (status.state !== "booted" || this.client === undefined) {
			return {
				ok: false,
				state: status.state,
				message: `Cannot complete swarm task "${request.taskId}" because swarm leader is ${status.state}. ${status.message}`,
				status,
				request,
			};
		}
		try {
			const result = await this.client.completeTask(request);
			const completeResult: SwarmCompleteResult = {
				ok: result.ok,
				state: status.state,
				message: result.message,
				status,
				request,
				response: result.payload,
			};
			return completeResult;
		} catch (error) {
			this.lastError = error instanceof Error ? error.message : String(error);
			const errorStatus = this.status();
			return {
				ok: false,
				state: errorStatus.state,
				message: this.lastError,
				status: errorStatus,
				request,
			};
		}
	}

	async snapshot(): Promise<SwarmSnapshotResult> {
		const status = this.status();
		if (status.state !== "booted" || this.client === undefined) {
			return {
				ok: false,
				state: status.state,
				message: `Cannot load swarm snapshot because swarm leader is ${status.state}. ${status.message}`,
				status,
			};
		}
		return {
			ok: true,
			state: status.state,
			message: "Swarm snapshot loaded.",
			status,
			instances: await this.client.listInstances(),
			tasks: await this.client.listTasks(),
			health: await this.client.statusSummary(),
		};
	}

	private startPoller(client: SwarmMcpClient): void {
		if (this.polling) return;
		this.polling = true;
		this.poller = this.pollLoop(client);
	}

	private async pollLoop(client: SwarmMcpClient): Promise<void> {
		while (this.polling && this.client === client) {
			try {
				const activity = await client.waitForActivity(10);
				if (!this.polling || this.client !== client || isSwarmTimeoutActivity(activity)) continue;
				const changes = swarmActivityChanges(activity);
				if (changes.length === 0) continue;
				const event: SwarmLeaderEvent = {
					type: "swarm.activity",
					changes,
					activity,
				};
				if (this.instanceId !== undefined) event.instanceId = this.instanceId;
				this.publish(event);
				if (changes.includes("kv_updates") || changes.includes("instance_changes")) {
					await this.ensurePlannerOwnership(client);
				}
			} catch (error) {
				if (!this.polling || this.client !== client) return;
				this.lastError = error instanceof Error ? error.message : String(error);
				this.publish({ type: "swarm.error", error: this.lastError });
				await delay(2000);
			}
		}
	}

	private publish(event: SwarmLeaderEvent): void {
		for (const listener of this.listeners) {
			listener(event);
		}
	}

	private async publishWorkspaceHandle(client: SwarmMcpClient, instanceId: string): Promise<void> {
		if (this.config.workspaceHandle === undefined) return;
		await client.kvSet(`identity/workspace/herdr/${instanceId}`, JSON.stringify(this.config.workspaceHandle));
	}

	private async ensurePlannerOwnership(client: SwarmMcpClient): Promise<void> {
		if (
			this.instanceId === undefined ||
			this.scope === undefined ||
			this.label === undefined ||
			!hasRole(this.label, "planner")
		) {
			return;
		}
		const status = recordOrUndefined(await client.statusSummary());
		const owner = recordOrUndefined(status?.planner_owner);
		const ownerId = stringProperty(owner, "instance_id");
		if (ownerId !== undefined) return;

		const kv = recordOrUndefined(status?.kv);
		if (stringProperty(kv, "owner/planner") !== undefined) return;

		await client.kvSet(
			"owner/planner",
			JSON.stringify({
				instance_id: this.instanceId,
				label: this.label,
				assigned_at: Date.now(),
			}),
		);
	}
}

function recordOrUndefined(value: unknown): Record<string, unknown> | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	return value as Record<string, unknown>;
}

function stringProperty(value: Record<string, unknown> | undefined, key: string): string | undefined {
	const item = value?.[key];
	return typeof item === "string" && item.trim().length > 0 ? item : undefined;
}

function hasRole(label: string, role: string): boolean {
	return label.split(/\s+/).includes(`role:${role}`);
}

async function delay(ms: number): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, ms));
}

function notBootedQueryResult(status: SwarmLeaderStatus, name: string): SwarmQueryResult {
	return {
		ok: false,
		state: status.state,
		message: `Cannot load swarm ${name} because swarm leader is ${status.state}. ${status.message}`,
		status,
	};
}

function readSwarmLeaderConfig(options: SwarmLeaderOptions): SwarmLeaderConfig {
	const env = options.env ?? process.env;
	const profile = options.profile;
	const profileDir = options.profileDir;
	const command = normalizedEnv(env.CLANKY_SWARM_COMMAND);
	const workspaceHandle = herdrWorkspaceHandle(env);
	return {
		enabled: isTruthyEnv(env.CLANKY_SWARM_ENABLED),
		profile,
		profileDir,
		identity: normalizedEnv(env.AGENT_IDENTITY) ?? profile,
		cwd: options.cwd ?? process.cwd(),
		databasePath: normalizedEnv(env.CLANKY_SWARM_DB_PATH) ?? join(profileDir, "swarm", "swarm.db"),
		args: readArgs(env.CLANKY_SWARM_ARGS_JSON),
		childEnv: swarmChildEnvironment(env),
		...(command === undefined ? {} : { command }),
		...(workspaceHandle === undefined ? {} : { workspaceHandle }),
	};
}

function swarmChildEnvironment(env: NodeJS.ProcessEnv): Record<string, string> {
	const result: Record<string, string> = {};
	for (const key of [
		"HERDR_PANE_ID",
		"HERDR_PANE",
		"HERDR_SOCKET",
		"HERDR_SOCKET_PATH",
		"HERDR_WORKSPACE_ID",
		"HERDR_TAB_ID",
		"HERMES_HOST_HOME",
		"SWARM_DISPATCH_HARNESS",
		"SWARM_DISPATCH_SPAWNER",
		"SWARM_HERDR_BIN",
		"SWARM_HERDR_MAX_PANES_PER_TAB",
		"SWARM_HERDR_PARENT_PANE",
		"SWARM_HERDR_SPLIT_DIRECTION",
		"SWARM_MCP_BIN",
		"SWARM_MCP_LAUNCH_DIR",
		"SWARM_SPAWNER",
		"SWARM_WORKER_HARNESS",
	]) {
		const value = normalizedEnv(env[key]);
		if (value !== undefined) result[key] = value;
	}
	for (const [key, value] of Object.entries(env)) {
		const normalized = normalizedEnv(value);
		if (normalized === undefined) continue;
		if (/^SWARM_HARNESS_[A-Z0-9_]+$/.test(key)) result[key] = normalized;
		if (/^SWARM_MCP_[A-Z0-9_]+_(ROOTS|HERDR_SOCKET_ROOT)$/.test(key)) result[key] = normalized;
	}
	return result;
}

function herdrWorkspaceHandle(env: NodeJS.ProcessEnv): HerdrWorkspaceHandle | undefined {
	const handle = normalizedEnv(env.HERDR_PANE_ID);
	if (handle === undefined) return undefined;
	const socketPath = normalizedEnv(env.HERDR_SOCKET_PATH) ?? normalizedEnv(env.HERDR_SOCKET);
	const workspace: HerdrWorkspaceHandle = {
		backend: "herdr",
		handle_kind: "pane",
		handle,
	};
	if (socketPath !== undefined) workspace.socket_path = socketPath;
	return workspace;
}

function normalizedEnv(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
}

function isTruthyEnv(value: string | undefined): boolean {
	const normalized = normalizedEnv(value)?.toLowerCase();
	return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

function readArgs(value: string | undefined): string[] {
	const normalized = normalizedEnv(value);
	if (normalized === undefined) return [];
	let parsed: unknown;
	try {
		parsed = JSON.parse(normalized);
	} catch {
		throw new Error("CLANKY_SWARM_ARGS_JSON must be a JSON string array");
	}
	if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === "string")) {
		throw new Error("CLANKY_SWARM_ARGS_JSON must be a JSON string array");
	}
	return parsed;
}
