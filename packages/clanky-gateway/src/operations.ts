import { createHash } from "node:crypto";
import type {
	CreateClankySkillInput,
	CreateClankyTaskInput,
	CreateCronJobInput,
	CreateLinearLinkInput,
	CronScheduler,
	LinearCreateIssueInput,
	LinearOutboxEntry,
	ListClankyTasksOptions,
	RegisteredSession,
	SessionRegistry,
	UpdateClankyTaskInput,
} from "@clanky/core";
import { formatSkillPrompt, hasLinearCredentials } from "@clanky/core";
import type {
	SwarmCompleteInput,
	SwarmDispatchInput,
	SwarmDispatchResult,
	SwarmFileLockResult,
	SwarmLeader,
	SwarmLeaderEvent,
	SwarmLeaderStatus,
	SwarmMessageInput,
	SwarmMessageResult,
	SwarmQueryResult,
	SwarmSnapshotResult,
} from "@clanky/swarm";
import {
	formatSwarmActivityCompletionComment,
	formatSwarmCompletionComment,
	type TerminalSwarmTask,
	type TerminalSwarmTaskStatus,
	withLinearTrackerFallback,
} from "@clanky/swarm";
import type { ExternalMcpManager } from "./external-mcp.ts";
import type {
	CronAddResult,
	CronJobIdParams,
	CronJobResult,
	CronListResult,
	CronRemoveResult,
	CronRunNowResult,
	ExternalMcpCallParams,
	ExternalMcpCallResult,
	ExternalMcpListResult,
	LinearCreateResult,
	LinearFlushParams,
	LinearFlushResult,
	LinearLinkResult,
	LinearListResult,
	LinearOutboxResult,
	SendParams,
	SendResult,
	SessionForkParams,
	SessionForkResult,
	SessionListResult,
	SessionSearchGatewayResult,
	SessionSearchParams,
	SkillAddResult,
	SkillListResult,
	SkillRemoveParams,
	SkillRemoveResult,
	SkillUsageResult,
	StatusResult,
	SwarmCompleteGatewayResult,
	TaskAddResult,
	TaskListResult,
	TaskUpdateResult,
} from "./protocol.ts";
import { type GatewayEventHub, gatewayEvent } from "./ws.ts";

export interface MirrorSwarmActivityResult {
	entries: LinearOutboxEntry[];
	sessionMessages?: number;
	linearFlush?: LinearFlushResult;
}

const CLANKY_SWARM_MESSAGE_ENTRY = "clanky.swarm_message";

export async function getStatus(
	registry: SessionRegistry,
	cron: CronScheduler,
	swarm: SwarmLeader,
	externalMcp: ExternalMcpManager,
	socketFile: string,
	startedAt: number,
): Promise<StatusResult> {
	const sessions = registry.list();
	const jobs = await cron.listJobs();
	const linearLinks = await registry.listLinearLinks();
	const linearOutbox = await registry.listLinearOutbox();
	const linearOutboxPending = linearOutbox.filter((entry) => entry.status === "pending").length;
	const linearConfigured = hasLinearCredentials();
	const swarmSnapshot = await statusSwarmSnapshot(swarm);
	const externalMcpServers = externalMcp.status();
	const warnings: string[] = [];
	if (linearLinks.length > 0 && !linearConfigured) {
		warnings.push("Linear links exist but LINEAR_API_KEY or LINEAR_ACCESS_TOKEN is not set");
	}
	if (linearOutboxPending > 0 && !linearConfigured) {
		warnings.push("Linear outbox has pending entries but LINEAR_API_KEY or LINEAR_ACCESS_TOKEN is not set");
	}
	if (swarmSnapshot.error !== undefined) warnings.push(swarmSnapshot.error);
	for (const server of externalMcpServers) {
		if (server.error !== undefined) warnings.push(`External MCP server ${server.name} failed: ${server.error}`);
	}
	return {
		ok: true,
		running: true,
		pid: process.pid,
		profile: registry.paths.profile,
		homeDir: registry.paths.homeDir,
		profileDir: registry.paths.profileDir,
		socketFile,
		daemonLockFile: registry.paths.daemonLockFile,
		liveSessions: sessions.length,
		sessionIds: sessions.map((session) => session.id),
		linearConfigured,
		linearOutboxPending,
		cronJobs: jobs.length,
		enabledCronJobs: jobs.filter((job) => job.enabled).length,
		swarm: swarm.status(),
		swarmPeers: swarmSnapshot.peers,
		swarmTasks: swarmSnapshot.tasks,
		externalMcpServers,
		warnings,
		uptimeMs: Date.now() - startedAt,
	};
}

async function statusSwarmSnapshot(swarm: SwarmLeader): Promise<{ peers: number; tasks: number; error?: string }> {
	const status = swarm.status();
	if (status.state !== "booted") return { peers: 0, tasks: 0 };
	try {
		const snapshot = await swarm.snapshot();
		if (!snapshot.ok) return { peers: 0, tasks: 0 };
		return {
			peers: countArray(snapshot.instances),
			tasks: countArray(snapshot.tasks),
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return {
			peers: 0,
			tasks: 0,
			error: `Swarm status snapshot failed: ${message}`,
		};
	}
}

function countArray(value: unknown): number {
	return Array.isArray(value) ? value.length : 0;
}

export function getSwarmStatus(swarm: SwarmLeader): SwarmLeaderStatus {
	return swarm.status();
}

export function listExternalMcpServers(externalMcp: ExternalMcpManager): ExternalMcpListResult {
	return { servers: externalMcp.status() };
}

export async function callExternalMcpTool(
	externalMcp: ExternalMcpManager,
	params: ExternalMcpCallParams,
): Promise<ExternalMcpCallResult> {
	return await externalMcp.callTool(params);
}

export async function dispatchSwarm(
	swarm: SwarmLeader,
	params: SwarmDispatchInput,
	registry?: SessionRegistry,
): Promise<SwarmDispatchResult> {
	const result = await swarm.dispatch(params);
	if (registry !== undefined && params.linearIssue !== undefined && result.taskId !== undefined) {
		await registry.linkLinearIssue({
			issueId: params.linearIssue,
			taskId: result.taskId,
			note: `swarm dispatch: ${params.title}`,
		});
	}
	return result;
}

export async function listSwarmPeers(swarm: SwarmLeader): Promise<SwarmQueryResult> {
	return await swarm.listInstances();
}

export async function listSwarmTasks(swarm: SwarmLeader): Promise<SwarmQueryResult> {
	return await swarm.listTasks();
}

export async function getSwarmSnapshot(swarm: SwarmLeader): Promise<SwarmSnapshotResult> {
	return await swarm.snapshot();
}

export async function getSwarmFileLock(swarm: SwarmLeader, file: string): Promise<SwarmFileLockResult> {
	return await swarm.getFileLock(file);
}

export async function messageSwarm(swarm: SwarmLeader, params: SwarmMessageInput): Promise<SwarmMessageResult> {
	return await swarm.message(params);
}

export async function completeSwarm(
	swarm: SwarmLeader,
	params: SwarmCompleteInput,
	registry?: SessionRegistry,
): Promise<SwarmCompleteGatewayResult> {
	const links =
		registry === undefined ? [] : (await registry.listLinearLinks()).filter((link) => link.taskId === params.taskId);
	const result = await swarm.complete(withLinearTrackerFallback(params, links.length > 0));
	if (!result.ok || registry === undefined) return result;

	if (links.length === 0) return result;

	const entries: LinearOutboxEntry[] = [];
	const body = formatSwarmCompletionComment(result);
	for (const link of links) {
		entries.push(
			await registry.addLinearOutboxEntry({
				issueId: link.issueId,
				taskId: result.request.taskId,
				kind: "comment",
				body,
				note: `swarm completion: ${result.request.status}`,
			}),
		);
	}
	if (hasLinearCredentials()) {
		const linearFlush = await registry.flushLinearOutbox({ entryIds: entries.map((entry) => entry.id) });
		return { ...result, linearOutboxEntries: entries, linearFlush };
	}
	return { ...result, linearOutboxEntries: entries };
}

export async function mirrorSwarmActivityToLinear(
	registry: SessionRegistry,
	event: SwarmLeaderEvent,
): Promise<MirrorSwarmActivityResult> {
	const sessionMessages = await appendSwarmMessagesToSessions(registry, event);
	if (event.type !== "swarm.activity" || !event.changes.includes("task_updates")) {
		return sessionMessages === 0 ? { entries: [] } : { entries: [], sessionMessages };
	}
	const tasks = terminalTasksFromActivity(event.activity);
	if (tasks.length === 0) return sessionMessages === 0 ? { entries: [] } : { entries: [], sessionMessages };

	const links = await registry.listLinearLinks();
	const outbox = await registry.listLinearOutbox();
	const entries: LinearOutboxEntry[] = [];
	for (const task of tasks) {
		const linkedIssues = links.filter((link) => link.taskId === task.id);
		const notifiedSessions = new Set<string>();
		for (const link of linkedIssues) {
			const alreadyRecorded = outbox.some(
				(entry) =>
					entry.issueId === link.issueId &&
					entry.taskId === task.id &&
					entry.kind === "comment" &&
					entry.note?.startsWith("swarm completion") === true,
			);
			if (alreadyRecorded) continue;
			const entry = await registry.addLinearOutboxEntry({
				issueId: link.issueId,
				taskId: task.id,
				kind: "comment",
				body: formatSwarmActivityCompletionComment(task),
				note: `swarm completion: ${task.status}`,
			});
			outbox.push(entry);
			entries.push(entry);
			if (link.sessionId !== undefined && !notifiedSessions.has(link.sessionId)) {
				notifiedSessions.add(link.sessionId);
				await appendSwarmCompletionToSession(registry, link.sessionId, task);
			}
		}
	}
	if (entries.length === 0) return sessionMessages === 0 ? { entries } : { entries, sessionMessages };
	if (!hasLinearCredentials()) return sessionMessages === 0 ? { entries } : { entries, sessionMessages };
	const result: MirrorSwarmActivityResult = {
		entries,
		linearFlush: await registry.flushLinearOutbox({ entryIds: entries.map((entry) => entry.id) }),
	};
	if (sessionMessages !== 0) result.sessionMessages = sessionMessages;
	return result;
}

export async function listSessions(registry: SessionRegistry): Promise<SessionListResult> {
	const sessions = await registry.listSummaries();
	return {
		sessions: sessions.map((session) => {
			const result: SessionListResult["sessions"][number] = {
				id: session.id,
				cwd: session.cwd,
				sessionFile: session.sessionFile,
				live: session.live,
			};
			if (session.messageCount !== undefined) result.messageCount = session.messageCount;
			if (session.firstMessage !== undefined) result.firstMessage = session.firstMessage;
			if (session.name !== undefined) result.name = session.name;
			return result;
		}),
	};
}

export async function forkSession(registry: SessionRegistry, params: SessionForkParams): Promise<SessionForkResult> {
	return await registry.forkSession(params);
}

export async function searchSessions(
	registry: SessionRegistry,
	params: SessionSearchParams,
): Promise<SessionSearchGatewayResult> {
	return { query: params.query, results: await registry.searchSessions(params) };
}

export function listSkills(registry: SessionRegistry): SkillListResult {
	const loaded = registry.loadSkills();
	return {
		skills: loaded.skills.map((skill) => ({
			name: skill.name,
			description: skill.description,
			filePath: skill.filePath,
		})),
		diagnostics: loaded.diagnostics.map((diagnostic) => diagnostic.message),
	};
}

export async function listSkillUsage(registry: SessionRegistry): Promise<SkillUsageResult> {
	return { usage: await registry.listSkillUsage() };
}

export async function addSkill(registry: SessionRegistry, params: CreateClankySkillInput): Promise<SkillAddResult> {
	return { skill: await registry.createSkill(params) };
}

export async function removeSkill(registry: SessionRegistry, params: SkillRemoveParams): Promise<SkillRemoveResult> {
	const skill = await registry.removeSkill(params.name);
	if (skill === undefined) return { removed: false };
	return { removed: true, skill };
}

export async function listTasks(registry: SessionRegistry, params: ListClankyTasksOptions): Promise<TaskListResult> {
	return { tasks: await registry.listTasks(params) };
}

export async function addTask(registry: SessionRegistry, params: CreateClankyTaskInput): Promise<TaskAddResult> {
	return { task: await registry.createTask(params) };
}

export async function updateTask(registry: SessionRegistry, params: UpdateClankyTaskInput): Promise<TaskUpdateResult> {
	const task = await registry.updateTask(params);
	if (task === undefined) return { updated: false };
	return { updated: true, task };
}

export async function listLinearLinks(registry: SessionRegistry): Promise<LinearListResult> {
	return { links: await registry.listLinearLinks() };
}

export async function listLinearOutbox(registry: SessionRegistry): Promise<LinearOutboxResult> {
	return { entries: await registry.listLinearOutbox() };
}

export async function createLinearIssue(
	registry: SessionRegistry,
	params: LinearCreateIssueInput,
): Promise<LinearCreateResult> {
	return { issue: await registry.createLinearIssue(params) };
}

export async function flushLinearOutbox(
	registry: SessionRegistry,
	params: LinearFlushParams,
): Promise<LinearFlushResult> {
	return await registry.flushLinearOutbox(params);
}

export async function linkLinearIssue(
	registry: SessionRegistry,
	params: CreateLinearLinkInput,
): Promise<LinearLinkResult> {
	return { link: await registry.linkLinearIssue(params) };
}

export async function sendPrompt(
	registry: SessionRegistry,
	params: SendParams,
	events?: GatewayEventHub,
): Promise<SendResult> {
	const registered = await sendSession(registry, params);
	const startedEvent: Parameters<GatewayEventHub["publish"]>[0] = {
		type: "session.started",
		timestamp: new Date().toISOString(),
		sessionId: registered.id,
	};
	if (registered.sessionFile !== undefined) startedEvent.sessionFile = registered.sessionFile;
	events?.publish(startedEvent);
	if (!registered.hasUsableModel) {
		events?.publish(
			gatewayEvent({
				type: "session.error",
				sessionId: registered.id,
				error: "No configured Pi model is available. Run `pi /login` or set provider API keys before sending prompts.",
			}),
		);
		throw new Error(
			"No configured Pi model is available. Run `pi /login` or set provider API keys before sending prompts.",
		);
	}
	if (params.skill !== undefined) {
		await registry.recordSkillUsage({
			name: params.skill,
			source: "session",
			sessionId: registered.id,
		});
	}
	const checkpointId = registered.session.sessionManager.appendCustomEntry("clanky.prompt_checkpoint", {
		source: "send",
		status: "started",
		prompt: params.prompt,
		...(params.skill === undefined ? {} : { skill: params.skill }),
		timestamp: new Date().toISOString(),
	});
	const pendingPrompt: Parameters<SessionRegistry["recordPendingPrompt"]>[0] = {
		sessionId: registered.id,
		cwd: registered.cwd,
		source: "send",
		prompt: params.prompt,
		...(params.skill === undefined ? {} : { skill: params.skill }),
	};
	const sessionFile = registered.session.sessionManager.getSessionFile();
	if (sessionFile !== undefined) pendingPrompt.sessionFile = sessionFile;
	await registry.recordPendingPrompt(pendingPrompt);
	await registry.refreshSessionFile(registered.id);

	const chunks: string[] = [];
	const unsubscribe = registered.session.subscribe((event) => {
		if (event.type !== "message_update") return;
		if (event.assistantMessageEvent.type !== "text_delta") return;
		chunks.push(event.assistantMessageEvent.delta);
		events?.publish(
			gatewayEvent({
				type: "session.text_delta",
				sessionId: registered.id,
				delta: event.assistantMessageEvent.delta,
			}),
		);
	});
	try {
		await registered.session.prompt(formatSkillPrompt(params));
		registered.session.sessionManager.appendCustomEntry("clanky.prompt_checkpoint", {
			source: "send",
			status: "completed",
			checkpointId,
			timestamp: new Date().toISOString(),
		});
		await registry.clearPendingPrompt(registered.id);
		await registry.refreshSessionFile(registered.id);
		events?.publish(
			gatewayEvent({
				type: "session.completed",
				sessionId: registered.id,
			}),
		);
	} finally {
		unsubscribe();
	}

	return {
		sessionId: registered.id,
		sessionFile: registered.sessionFile,
		text: chunks.join(""),
	};
}

async function sendSession(registry: SessionRegistry, params: SendParams): Promise<RegisteredSession> {
	if (params.sessionId !== undefined) {
		if (params.provider !== undefined || params.model !== undefined) {
			return await registry.applyModelOverride(params.sessionId, params.provider, params.model);
		}
		return await registry.getOrOpen(params.sessionId);
	}
	return await registry.createSession({
		...(params.provider === undefined ? {} : { provider: params.provider }),
		...(params.model === undefined ? {} : { model: params.model }),
	});
}

export async function listCronJobs(scheduler: CronScheduler): Promise<CronListResult> {
	return { jobs: await scheduler.listJobs() };
}

export async function addCronJob(
	scheduler: CronScheduler,
	params: CreateCronJobInput,
	events?: GatewayEventHub,
): Promise<CronAddResult> {
	const job = await scheduler.addJob(params);
	events?.publish(gatewayEvent({ type: "cron.changed", action: "add", jobId: job.id }));
	return { job };
}

export async function removeCronJob(
	scheduler: CronScheduler,
	params: CronJobIdParams,
	events?: GatewayEventHub,
): Promise<CronRemoveResult> {
	const removed = await scheduler.removeJob(params.jobId);
	if (removed) events?.publish(gatewayEvent({ type: "cron.changed", action: "remove", jobId: params.jobId }));
	return { removed };
}

export async function enableCronJob(
	scheduler: CronScheduler,
	params: CronJobIdParams,
	events?: GatewayEventHub,
): Promise<CronJobResult> {
	const job = await scheduler.setJobEnabled(params.jobId, true);
	events?.publish(gatewayEvent({ type: "cron.changed", action: "enable", jobId: job.id }));
	return { job };
}

export async function disableCronJob(
	scheduler: CronScheduler,
	params: CronJobIdParams,
	events?: GatewayEventHub,
): Promise<CronJobResult> {
	const job = await scheduler.setJobEnabled(params.jobId, false);
	events?.publish(gatewayEvent({ type: "cron.changed", action: "disable", jobId: job.id }));
	return { job };
}

export async function runCronJobNow(
	scheduler: CronScheduler,
	params: CronJobIdParams,
	events?: GatewayEventHub,
): Promise<CronRunNowResult> {
	const result = await scheduler.runNow(params.jobId);
	const eventInput: Parameters<typeof gatewayEvent>[0] = {
		type: "cron.ran",
		jobId: params.jobId,
		ok: result.ok,
	};
	if (result.error !== undefined) eventInput.error = result.error;
	events?.publish(gatewayEvent(eventInput));
	return { result };
}

function terminalTasksFromActivity(activity: unknown): TerminalSwarmTask[] {
	const tasks = recordProperty(activity, "tasks");
	if (tasks === undefined) return [];
	const terminal: TerminalSwarmTask[] = [];
	for (const status of ["done", "failed", "cancelled"] as const) {
		const items = tasks[status];
		if (!Array.isArray(items)) continue;
		for (const item of items) {
			const task = terminalTask(item, status);
			if (task !== undefined) terminal.push(task);
		}
	}
	return terminal;
}

function terminalTask(value: unknown, status: TerminalSwarmTaskStatus): TerminalSwarmTask | undefined {
	const record = recordOrUndefined(value);
	const id = stringProperty(record, "id");
	if (id === undefined) return undefined;
	const task: TerminalSwarmTask = { id, status };
	const title = stringProperty(record, "title");
	if (title !== undefined) task.title = title;
	if (record?.result !== undefined) task.result = record.result;
	return task;
}

async function appendSwarmCompletionToSession(
	registry: SessionRegistry,
	sessionId: string,
	task: TerminalSwarmTask,
): Promise<void> {
	try {
		const registered = await registry.getOrOpen(sessionId);
		registered.session.sessionManager.appendCustomEntry("clanky.swarm_completion", {
			taskId: task.id,
			status: task.status,
			...(task.title === undefined ? {} : { title: task.title }),
			...(task.result === undefined ? {} : { result: task.result }),
			timestamp: new Date().toISOString(),
		});
		await registry.refreshSessionFile(registered.id);
	} catch {
		return;
	}
}

interface SwarmActivityMessage {
	key: string;
	sender: string;
	content: string;
	createdAt: string;
	sessionId?: string;
	taskId?: string;
}

async function appendSwarmMessagesToSessions(registry: SessionRegistry, event: SwarmLeaderEvent): Promise<number> {
	if (event.type !== "swarm.activity" || !event.changes.includes("new_messages")) return 0;
	const messages = swarmMessagesFromActivity(event.activity);
	if (messages.length === 0) return 0;
	const links = await registry.listLinearLinks();
	let appended = 0;
	for (const message of messages) {
		const sessionIds = targetSessionIdsForSwarmMessage(message, links);
		for (const sessionId of sessionIds) {
			if (await appendSwarmMessageToSession(registry, sessionId, message)) appended += 1;
		}
	}
	return appended;
}

function swarmMessagesFromActivity(activity: unknown): SwarmActivityMessage[] {
	const messages = recordOrUndefined(activity)?.messages;
	if (!Array.isArray(messages)) return [];
	const parsed: SwarmActivityMessage[] = [];
	for (const message of messages) {
		const parsedMessage = swarmActivityMessage(message);
		if (parsedMessage !== undefined) parsed.push(parsedMessage);
	}
	return parsed;
}

function swarmActivityMessage(value: unknown): SwarmActivityMessage | undefined {
	const record = recordOrUndefined(value);
	if (record === undefined) return undefined;
	const rawContent =
		stringProperty(record, "content") ??
		stringProperty(record, "message") ??
		stringProperty(record, "text") ??
		stringProperty(record, "body");
	if (rawContent === undefined) return undefined;

	const payload = recordOrUndefined(parseJson(rawContent));
	const payloadContent =
		stringProperty(payload, "content") ??
		stringProperty(payload, "message") ??
		stringProperty(payload, "text") ??
		stringProperty(payload, "body");
	const contentSource = payloadContent ?? rawContent;
	const prefix = parseSwarmMessagePrefixes(contentSource);
	const content = prefix.content.trim();
	if (content.length === 0) return undefined;

	const id = stringOrNumberProperty(record, "id") ?? stringOrNumberProperty(payload, "id");
	const sender =
		stringProperty(record, "sender") ??
		stringProperty(record, "from") ??
		stringProperty(payload, "sender") ??
		stringProperty(payload, "from") ??
		"swarm";
	const createdAt = swarmMessageCreatedAt(
		record.created_at ?? payload?.created_at ?? record.createdAt ?? payload?.createdAt,
	);
	const sessionId =
		stringProperty(record, "sessionId") ??
		stringProperty(record, "session_id") ??
		stringProperty(record, "targetSessionId") ??
		stringProperty(record, "target_session_id") ??
		stringProperty(payload, "sessionId") ??
		stringProperty(payload, "session_id") ??
		stringProperty(payload, "targetSessionId") ??
		stringProperty(payload, "target_session_id") ??
		prefix.sessionId;
	const taskId =
		stringProperty(record, "taskId") ??
		stringProperty(record, "task_id") ??
		stringProperty(payload, "taskId") ??
		stringProperty(payload, "task_id") ??
		prefix.taskId;

	const message: SwarmActivityMessage = {
		key: id ?? stableSwarmMessageKey(sender, content, createdAt),
		sender,
		content,
		createdAt,
	};
	if (sessionId !== undefined) message.sessionId = sessionId;
	if (taskId !== undefined) message.taskId = taskId;
	return message;
}

function targetSessionIdsForSwarmMessage(
	message: SwarmActivityMessage,
	links: Awaited<ReturnType<SessionRegistry["listLinearLinks"]>>,
): string[] {
	const sessionIds = new Set<string>();
	if (message.sessionId !== undefined) sessionIds.add(message.sessionId);
	if (message.taskId !== undefined) {
		for (const link of links) {
			if (link.taskId === message.taskId && link.sessionId !== undefined) sessionIds.add(link.sessionId);
		}
	}
	return [...sessionIds];
}

async function appendSwarmMessageToSession(
	registry: SessionRegistry,
	sessionId: string,
	message: SwarmActivityMessage,
): Promise<boolean> {
	try {
		const registered = await registry.getOrOpen(sessionId);
		const markerKey = `${registered.id}:${message.key}`;
		if (hasSwarmMessageMarker(registered, markerKey)) return false;
		const content = formatSwarmSessionMessage(message);
		registered.session.sessionManager.appendCustomEntry(CLANKY_SWARM_MESSAGE_ENTRY, {
			messageKey: markerKey,
			sender: message.sender,
			...(message.taskId === undefined ? {} : { taskId: message.taskId }),
			timestamp: message.createdAt,
		});
		registered.session.sessionManager.appendMessage({
			role: "user",
			content,
			timestamp: swarmMessageTimestamp(message.createdAt),
		});
		const sessionFile = await registry.refreshSessionFile(registered.id);
		await registry.recordSessionMessage({
			sessionId: registered.id,
			role: "user",
			text: content,
			cwd: registered.cwd,
			createdAt: message.createdAt,
			...(sessionFile === undefined ? {} : { sessionFile }),
			messageKey: `${registered.id}:swarm:${message.key}`,
		});
		return true;
	} catch {
		return false;
	}
}

function hasSwarmMessageMarker(registered: RegisteredSession, markerKey: string): boolean {
	return registered.session.sessionManager.getEntries().some((entry) => {
		if (entry.type !== "custom" || entry.customType !== CLANKY_SWARM_MESSAGE_ENTRY) return false;
		return stringProperty(recordOrUndefined(entry.data), "messageKey") === markerKey;
	});
}

function formatSwarmSessionMessage(message: SwarmActivityMessage): string {
	const task = message.taskId === undefined ? "" : ` for task ${message.taskId}`;
	return `Swarm message from ${message.sender}${task}:\n\n${message.content}`;
}

interface SwarmMessagePrefixParse {
	content: string;
	sessionId?: string;
	taskId?: string;
}

function parseSwarmMessagePrefixes(content: string): SwarmMessagePrefixParse {
	let rest = content;
	let sessionId: string | undefined;
	let taskId: string | undefined;
	for (let index = 0; index < 4; index += 1) {
		const bracket = rest.match(/^\s*\[(session|task):([^\]\s]+)\]\s*/i);
		const bare = bracket === null ? rest.match(/^\s*(session|task):([^\s]+)\s*/i) : null;
		const match = bracket ?? bare;
		if (match === null) break;
		const type = match[1]?.toLowerCase();
		const value = match[2]?.trim();
		if (type === "session" && value !== undefined && value.length > 0) sessionId = value;
		if (type === "task" && value !== undefined && value.length > 0) taskId = value;
		rest = rest.slice(match[0].length);
	}
	const result: SwarmMessagePrefixParse = { content: rest };
	if (sessionId !== undefined) result.sessionId = sessionId;
	if (taskId !== undefined) result.taskId = taskId;
	return result;
}

function swarmMessageCreatedAt(value: unknown): string {
	if (typeof value === "number" && Number.isFinite(value)) return new Date(unixLikeTimestampMs(value)).toISOString();
	if (typeof value === "string") {
		const asNumber = Number(value);
		if (Number.isFinite(asNumber) && value.trim().length > 0)
			return new Date(unixLikeTimestampMs(asNumber)).toISOString();
		const parsed = Date.parse(value);
		if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
	}
	return new Date().toISOString();
}

function swarmMessageTimestamp(createdAt: string): number {
	const parsed = Date.parse(createdAt);
	return Number.isFinite(parsed) ? parsed : Date.now();
}

function unixLikeTimestampMs(value: number): number {
	return value < 1_000_000_000_000 ? value * 1000 : value;
}

function stableSwarmMessageKey(sender: string, content: string, createdAt: string): string {
	return createHash("sha256").update(`${sender}\0${createdAt}\0${content}`).digest("hex");
}

function recordProperty(value: unknown, key: string): Record<string, unknown> | undefined {
	return recordOrUndefined(recordOrUndefined(value)?.[key]);
}

function recordOrUndefined(value: unknown): Record<string, unknown> | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	return value as Record<string, unknown>;
}

function stringProperty(record: Record<string, unknown> | undefined, key: string): string | undefined {
	const value = record?.[key];
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed.length === 0 ? undefined : trimmed;
}

function stringOrNumberProperty(record: Record<string, unknown> | undefined, key: string): string | undefined {
	const value = record?.[key];
	if (typeof value === "string") {
		const trimmed = value.trim();
		return trimmed.length === 0 ? undefined : trimmed;
	}
	if (typeof value === "number" && Number.isFinite(value)) return String(value);
	return undefined;
}

function parseJson(value: string): unknown {
	try {
		return JSON.parse(value) as unknown;
	} catch {
		return undefined;
	}
}
