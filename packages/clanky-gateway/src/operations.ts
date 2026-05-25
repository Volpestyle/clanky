import type {
	CreateClankySkillInput,
	CreateClankyTaskInput,
	CreateCronJobInput,
	CreateLinearLinkInput,
	CronScheduler,
	ForgetMemoryInput,
	LinearCreateIssueInput,
	ListClankyTasksOptions,
	MemoryExport,
	MemoryForgetResult,
	MemorySearchOptions,
	MemorySearchResult,
	MemoryStatus,
	MemoryWriteResult,
	ModelAuthMutationResult,
	ModelAuthStatus,
	RegisteredSession,
	RememberMemoryInput,
	SessionRegistry,
	SetMemoryConsentInput,
	UpdateClankyTaskInput,
} from "@clanky/core";
import { formatSkillPrompt, hasLinearCredentials } from "@clanky/core";
import type {
	ChatSessionMapping,
	MessagingManager,
	Platform as MessagingPlatform,
	MessagingStatus,
} from "@clanky/messaging";
import type { ExternalMcpManager } from "./external-mcp.ts";
import type {
	AuthOAuthBeginParams,
	AuthOAuthBeginResult,
	AuthOAuthCancelResult,
	AuthOAuthWaitParams,
	AuthOAuthWaitResult,
	AuthRemoveParams,
	AuthSetApiKeyParams,
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
	TaskAddResult,
	TaskListResult,
	TaskUpdateResult,
} from "./protocol.ts";
import { type GatewayEventHub, gatewayEvent } from "./ws.ts";

export function getAuthStatus(registry: SessionRegistry): ModelAuthStatus {
	return registry.modelAuthStatus();
}

export function setAuthApiKey(registry: SessionRegistry, params: AuthSetApiKeyParams): ModelAuthMutationResult {
	return registry.setModelApiKey(params.provider, params.apiKey);
}

export function removeAuth(registry: SessionRegistry, params: AuthRemoveParams): ModelAuthMutationResult {
	return registry.removeModelAuth(params.provider);
}

export async function beginAuthOAuth(
	registry: SessionRegistry,
	params: AuthOAuthBeginParams,
): Promise<AuthOAuthBeginResult> {
	return await registry.beginModelOAuthLogin(params.provider);
}

export async function waitAuthOAuth(
	registry: SessionRegistry,
	params: AuthOAuthWaitParams,
): Promise<AuthOAuthWaitResult> {
	return await registry.waitModelOAuthLogin(params.loginId);
}

export function cancelAuthOAuth(registry: SessionRegistry, params: AuthOAuthWaitParams): AuthOAuthCancelResult {
	return registry.cancelModelOAuthLogin(params.loginId);
}

export async function getMemoryStatus(registry: SessionRegistry): Promise<MemoryStatus> {
	return await registry.memoryStatus();
}

export async function searchMemory(
	registry: SessionRegistry,
	params: MemorySearchOptions,
): Promise<MemorySearchResult> {
	return await registry.searchMemory(params);
}

export async function rememberMemory(
	registry: SessionRegistry,
	params: RememberMemoryInput,
): Promise<MemoryWriteResult> {
	return await registry.rememberMemory(params);
}

export async function forgetMemory(registry: SessionRegistry, params: ForgetMemoryInput): Promise<MemoryForgetResult> {
	return await registry.forgetMemory(params);
}

export async function exportMemory(registry: SessionRegistry): Promise<MemoryExport> {
	return await registry.exportMemory();
}

export async function setMemoryConsent(registry: SessionRegistry, params: SetMemoryConsentInput): Promise<unknown> {
	return await registry.setMemoryConsent(params);
}

export async function getStatus(
	registry: SessionRegistry,
	cron: CronScheduler,
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
	const externalMcpServers = externalMcp.status();
	const warnings: string[] = [];
	if (linearLinks.length > 0 && !linearConfigured) {
		warnings.push("Linear links exist but LINEAR_API_KEY or LINEAR_ACCESS_TOKEN is not set");
	}
	if (linearOutboxPending > 0 && !linearConfigured) {
		warnings.push("Linear outbox has pending entries but LINEAR_API_KEY or LINEAR_ACCESS_TOKEN is not set");
	}
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
		externalMcpServers,
		warnings,
		uptimeMs: Date.now() - startedAt,
	};
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

export interface MessagingStatusGatewayResult extends MessagingStatus {
	configured: boolean;
}

export interface MessagingSessionsResult {
	mappings: ChatSessionMapping[];
}

export interface MessagingResetParams {
	platform: MessagingPlatform;
	chatId: string;
	threadId?: string;
	userId?: string;
}

export interface MessagingResetResult {
	ok: true;
}

export function getMessagingStatus(messaging: MessagingManager): MessagingStatusGatewayResult {
	const status = messaging.status();
	return {
		...status,
		configured: status.telegram.enabled || status.discord.enabled,
	};
}

export async function listMessagingSessions(
	messaging: MessagingManager,
	platform?: MessagingPlatform,
): Promise<MessagingSessionsResult> {
	return { mappings: await messaging.broker.listMappings(platform) };
}

export async function resetMessagingSession(
	messaging: MessagingManager,
	params: MessagingResetParams,
): Promise<MessagingResetResult> {
	const key: Parameters<typeof messaging.broker.resetMapping>[0] = {
		platform: params.platform,
		chatId: params.chatId,
	};
	if (params.threadId !== undefined) key.threadId = params.threadId;
	if (params.userId !== undefined) key.userId = params.userId;
	await messaging.broker.resetMapping(key);
	return { ok: true };
}

export function readMessagingResetParams(value: unknown): MessagingResetParams {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error("messaging.reset params must be an object");
	}
	const record = value as Record<string, unknown>;
	const platform = record.platform;
	if (platform !== "telegram" && platform !== "discord") {
		throw new Error("messaging.reset platform must be 'telegram' or 'discord'");
	}
	const chatId = record.chatId;
	if (typeof chatId !== "string" || chatId.length === 0) {
		throw new Error("messaging.reset chatId must be a non-empty string");
	}
	const params: MessagingResetParams = { platform, chatId };
	if (typeof record.threadId === "string" && record.threadId.length > 0) params.threadId = record.threadId;
	if (typeof record.userId === "string" && record.userId.length > 0) params.userId = record.userId;
	return params;
}

export function readMessagingSessionsParams(value: unknown): MessagingPlatform | undefined {
	if (value === undefined || value === null) return undefined;
	if (typeof value !== "object" || Array.isArray(value)) return undefined;
	const platform = (value as Record<string, unknown>).platform;
	if (platform === "telegram" || platform === "discord") return platform;
	return undefined;
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
