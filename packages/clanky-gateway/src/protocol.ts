import type {
	ClankyTask,
	LinearCreateIssueResult as CoreLinearCreateIssueResult,
	CreateClankySkillInput,
	CreateClankyTaskInput,
	CreateCronJobInput,
	CreateLinearLinkInput,
	CronDelivery,
	CronJob,
	CronRunResult,
	FlushLinearOutboxResult,
	ForgetMemoryInput,
	LinearCreateIssueInput,
	LinearLink,
	LinearOutboxEntry,
	ListClankyTasksOptions,
	MemoryExport,
	MemoryForgetResult,
	MemorySearchOptions,
	MemorySearchResult,
	MemoryStatus,
	MemoryWriteResult,
	ModelAuthMutationResult,
	ModelAuthStatus,
	RememberMemoryInput,
	SessionSearchResult,
	SetMemoryConsentInput,
	SkillUsageRecord,
	UpdateClankyTaskInput,
} from "@clanky/core";

export type GatewayMethod =
	| "status"
	| "auth.status"
	| "auth.set_api_key"
	| "auth.remove"
	| "memory.status"
	| "memory.search"
	| "memory.remember"
	| "memory.forget"
	| "memory.export"
	| "memory.consent"
	| "send"
	| "session.list"
	| "session.fork"
	| "session.search"
	| "skill.list"
	| "skill.usage"
	| "skill.add"
	| "skill.remove"
	| "task.list"
	| "task.add"
	| "task.update"
	| "mcp.list"
	| "mcp.call"
	| "linear.list"
	| "linear.create"
	| "linear.link"
	| "linear.outbox"
	| "linear.flush"
	| "cron.list"
	| "cron.add"
	| "cron.remove"
	| "cron.enable"
	| "cron.disable"
	| "cron.run_now"
	| "messaging.status"
	| "messaging.sessions"
	| "messaging.reset"
	| "shutdown";

export interface GatewayRequest {
	id: string;
	method: GatewayMethod;
	params?: unknown;
}

export type GatewayResponse =
	| {
			id: string;
			ok: true;
			result: unknown;
	  }
	| {
			id: string;
			ok: false;
			error: string;
	  };

export interface SendParams {
	prompt: string;
	sessionId?: string;
	skill?: string;
	provider?: string;
	model?: string;
}

export interface SendResult {
	sessionId: string;
	sessionFile: string | undefined;
	text: string;
}

export interface StatusResult {
	ok: true;
	running: true;
	pid: number;
	profile: string;
	homeDir: string;
	profileDir: string;
	socketFile: string;
	daemonLockFile: string;
	liveSessions: number;
	sessionIds: string[];
	linearConfigured: boolean;
	linearOutboxPending: number;
	cronJobs: number;
	enabledCronJobs: number;
	externalMcpServers: ExternalMcpServerStatus[];
	warnings: string[];
	uptimeMs: number;
}

export type AuthStatusResult = ModelAuthStatus;

export interface AuthSetApiKeyParams {
	apiKey: string;
	provider: string;
}

export interface AuthRemoveParams {
	provider: string;
}

export type AuthSetApiKeyResult = ModelAuthMutationResult;

export type AuthRemoveResult = ModelAuthMutationResult;

export type MemoryStatusResult = MemoryStatus;

export type MemorySearchParams = MemorySearchOptions;

export type MemorySearchGatewayResult = MemorySearchResult;

export type MemoryRememberParams = RememberMemoryInput;

export type MemoryRememberResult = MemoryWriteResult;

export type MemoryForgetParams = ForgetMemoryInput;

export type MemoryForgetGatewayResult = MemoryForgetResult;

export type MemoryExportResult = MemoryExport;

export type MemoryConsentParams = SetMemoryConsentInput;

export interface SessionListResult {
	sessions: Array<{
		id: string;
		cwd: string;
		sessionFile: string | undefined;
		live: boolean;
		messageCount?: number;
		firstMessage?: string;
		name?: string;
	}>;
}

export interface SessionForkParams {
	sourceSessionId: string;
	cwd?: string;
}

export interface SessionForkResult {
	sourceSessionId: string;
	sourceSessionFile: string;
	sessionId: string;
	sessionFile: string | undefined;
	cwd: string;
}

export interface SessionSearchParams {
	query: string;
	limit?: number;
}

export interface SessionSearchGatewayResult {
	query: string;
	results: SessionSearchResult[];
}

export interface CronListResult {
	jobs: CronJob[];
}

export interface SkillListResult {
	skills: Array<{
		name: string;
		description: string;
		filePath: string;
	}>;
	diagnostics: string[];
}

export interface SkillUsageResult {
	usage: SkillUsageRecord[];
}

export interface SkillAddResult {
	skill: {
		name: string;
		filePath: string;
	};
}

export interface SkillRemoveParams {
	name: string;
}

export interface SkillRemoveResult {
	removed: boolean;
	skill?: {
		name: string;
		filePath: string;
	};
}

export interface TaskListResult {
	tasks: ClankyTask[];
}

export interface TaskAddResult {
	task: ClankyTask;
}

export interface TaskUpdateResult {
	updated: boolean;
	task?: ClankyTask;
}

export interface LinearListResult {
	links: LinearLink[];
}

export interface LinearLinkResult {
	link: LinearLink;
}

export interface LinearCreateResult {
	issue: CoreLinearCreateIssueResult;
}

export interface ExternalMcpToolSummary {
	name: string;
	description?: string;
}

export interface ExternalMcpServerStatus {
	name: string;
	state: "booted" | "error";
	command: string;
	args: string[];
	cwd: string;
	tools: ExternalMcpToolSummary[];
	error?: string;
}

export interface ExternalMcpListResult {
	servers: ExternalMcpServerStatus[];
}

export interface ExternalMcpCallParams {
	server: string;
	tool: string;
	arguments?: Record<string, unknown>;
}

export interface ExternalMcpCallResult {
	server: string;
	tool: string;
	result: unknown;
}

export interface LinearOutboxResult {
	entries: LinearOutboxEntry[];
}

export interface LinearFlushParams {
	limit?: number;
}

export type LinearFlushResult = FlushLinearOutboxResult;

export interface CronAddResult {
	job: CronJob;
}

export interface CronJobResult {
	job: CronJob;
}

export interface CronRemoveResult {
	removed: boolean;
}

export interface CronRunNowResult {
	result: CronRunResult;
}

export interface CronJobIdParams {
	jobId: string;
}

export function isGatewayRequest(value: unknown): value is GatewayRequest {
	if (typeof value !== "object" || value === null) return false;
	const candidate = value as Record<string, unknown>;
	if (typeof candidate.id !== "string") return false;
	return (
		candidate.method === "status" ||
		candidate.method === "auth.status" ||
		candidate.method === "auth.set_api_key" ||
		candidate.method === "auth.remove" ||
		candidate.method === "memory.status" ||
		candidate.method === "memory.search" ||
		candidate.method === "memory.remember" ||
		candidate.method === "memory.forget" ||
		candidate.method === "memory.export" ||
		candidate.method === "memory.consent" ||
		candidate.method === "send" ||
		candidate.method === "session.list" ||
		candidate.method === "session.fork" ||
		candidate.method === "session.search" ||
		candidate.method === "skill.list" ||
		candidate.method === "skill.usage" ||
		candidate.method === "skill.add" ||
		candidate.method === "skill.remove" ||
		candidate.method === "task.list" ||
		candidate.method === "task.add" ||
		candidate.method === "task.update" ||
		candidate.method === "mcp.list" ||
		candidate.method === "mcp.call" ||
		candidate.method === "linear.list" ||
		candidate.method === "linear.create" ||
		candidate.method === "linear.link" ||
		candidate.method === "linear.outbox" ||
		candidate.method === "linear.flush" ||
		candidate.method === "cron.list" ||
		candidate.method === "cron.add" ||
		candidate.method === "cron.remove" ||
		candidate.method === "cron.enable" ||
		candidate.method === "cron.disable" ||
		candidate.method === "cron.run_now" ||
		candidate.method === "messaging.status" ||
		candidate.method === "messaging.sessions" ||
		candidate.method === "messaging.reset" ||
		candidate.method === "shutdown"
	);
}

export function readMemorySearchParams(value: unknown): MemorySearchParams {
	if (value === undefined) return {};
	if (typeof value !== "object" || value === null) {
		throw new Error("memory search params must be an object");
	}
	const candidate = value as Record<string, unknown>;
	const params: MemorySearchParams = {};
	const query = candidate.query ?? candidate.q;
	if (query !== undefined) {
		if (typeof query !== "string" || query.trim().length === 0) {
			throw new Error("memory search query must be a non-empty string");
		}
		params.query = query;
	}
	const scope = candidate.scope;
	if (scope !== undefined) params.scope = readMemoryScope(scope);
	const subjectId = candidate.subjectId ?? candidate.subject_id;
	if (subjectId !== undefined) params.subjectId = readNonEmptyString(subjectId, "memory search subjectId");
	if (candidate.limit !== undefined) params.limit = readPositiveInteger(candidate.limit, "memory search limit");
	return params;
}

export function readMemoryRememberParams(value: unknown): MemoryRememberParams {
	if (typeof value !== "object" || value === null) {
		throw new Error("memory remember params must be an object");
	}
	const candidate = value as Record<string, unknown>;
	const claim = readNonEmptyString(candidate.claim, "memory remember claim");
	const params: MemoryRememberParams = { claim };
	if (candidate.scope !== undefined) params.scope = readMemoryScope(candidate.scope);
	const subjectId = candidate.subjectId ?? candidate.subject_id;
	if (subjectId !== undefined) params.subjectId = readNonEmptyString(subjectId, "memory remember subjectId");
	if (candidate.type !== undefined) params.type = readMemoryType(candidate.type);
	const sourceEventIds = candidate.sourceEventIds ?? candidate.source_event_ids;
	if (sourceEventIds !== undefined) params.sourceEventIds = readStringArray(sourceEventIds, "memory sourceEventIds");
	const sourceText = candidate.sourceText ?? candidate.source_text;
	if (sourceText !== undefined) {
		params.source = {
			scope: params.scope ?? "project",
			subjectId: params.subjectId ?? "gateway",
			source: "gateway",
			text: readNonEmptyString(sourceText, "memory sourceText"),
		};
	}
	if (candidate.confidence !== undefined)
		params.confidence = readFiniteNumber(candidate.confidence, "memory confidence");
	if (candidate.sensitivity !== undefined) params.sensitivity = readMemorySensitivity(candidate.sensitivity);
	if (candidate.ttlDays !== undefined || candidate.ttl_days !== undefined) {
		params.ttlDays = readPositiveInteger(candidate.ttlDays ?? candidate.ttl_days, "memory ttlDays");
	}
	if (candidate.confirmed !== undefined) {
		if (typeof candidate.confirmed !== "boolean") throw new Error("memory confirmed must be boolean");
		params.confirmed = candidate.confirmed;
	}
	return params;
}

export function readMemoryForgetParams(value: unknown): MemoryForgetParams {
	if (typeof value !== "object" || value === null) {
		throw new Error("memory forget params must be an object");
	}
	const candidate = value as Record<string, unknown>;
	const params: MemoryForgetParams = {};
	if (candidate.id !== undefined) params.id = readNonEmptyString(candidate.id, "memory id");
	if (candidate.scope !== undefined) params.scope = readMemoryScope(candidate.scope);
	const subjectId = candidate.subjectId ?? candidate.subject_id;
	if (subjectId !== undefined) params.subjectId = readNonEmptyString(subjectId, "memory subjectId");
	return params;
}

export function readMemoryConsentParams(value: unknown): MemoryConsentParams {
	if (typeof value !== "object" || value === null) {
		throw new Error("memory consent params must be an object");
	}
	const candidate = value as Record<string, unknown>;
	const enabled = candidate.enabled;
	if (typeof enabled !== "boolean") throw new Error("memory consent enabled must be boolean");
	const params: MemoryConsentParams = {
		scope: readMemoryScope(candidate.scope),
		subjectId: readNonEmptyString(candidate.subjectId ?? candidate.subject_id, "memory consent subjectId"),
		enabled,
	};
	if (candidate.mode !== undefined) params.mode = readMemoryConsentMode(candidate.mode);
	if (candidate.retentionDays !== undefined || candidate.retention_days !== undefined) {
		params.retentionDays = readPositiveInteger(
			candidate.retentionDays ?? candidate.retention_days,
			"memory retentionDays",
		);
	}
	if (candidate.notice !== undefined) params.notice = readNonEmptyString(candidate.notice, "memory consent notice");
	return params;
}

export function readAuthSetApiKeyParams(value: unknown): AuthSetApiKeyParams {
	if (typeof value !== "object" || value === null) {
		throw new Error("auth set params must be an object");
	}
	const candidate = value as Record<string, unknown>;
	const provider = readAuthProvider(candidate.provider ?? "openai");
	const apiKey = candidate.apiKey ?? candidate.api_key;
	if (typeof apiKey !== "string" || apiKey.trim().length === 0) {
		throw new Error("auth set params require a non-empty apiKey");
	}
	return { provider, apiKey };
}

function readMemoryScope(value: unknown): NonNullable<MemorySearchOptions["scope"]> {
	if (
		value === "user" ||
		value === "dm" ||
		value === "guild" ||
		value === "channel" ||
		value === "project" ||
		value === "agent"
	) {
		return value;
	}
	throw new Error("invalid memory scope");
}

function readMemoryType(value: unknown): NonNullable<MemoryRememberParams["type"]> {
	if (
		value === "preference" ||
		value === "fact" ||
		value === "decision" ||
		value === "commitment" ||
		value === "lesson" ||
		value === "skill_hint"
	) {
		return value;
	}
	throw new Error("invalid memory type");
}

function readMemorySensitivity(value: unknown): NonNullable<MemoryRememberParams["sensitivity"]> {
	if (value === "public" || value === "personal" || value === "sensitive" || value === "secret") return value;
	throw new Error("invalid memory sensitivity");
}

function readMemoryConsentMode(value: unknown): NonNullable<MemoryConsentParams["mode"]> {
	if (value === "mention" || value === "dm" || value === "channel" || value === "server" || value === "off")
		return value;
	throw new Error("invalid memory consent mode");
}

function readNonEmptyString(value: unknown, label: string): string {
	if (typeof value !== "string" || value.trim().length === 0) throw new Error(`${label} must be a non-empty string`);
	return value;
}

function readFiniteNumber(value: unknown, label: string): number {
	if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${label} must be finite`);
	return value;
}

function readPositiveInteger(value: unknown, label: string): number {
	const parsed = typeof value === "string" ? Number.parseInt(value, 10) : value;
	if (typeof parsed !== "number" || !Number.isInteger(parsed) || parsed <= 0) {
		throw new Error(`${label} must be a positive integer`);
	}
	return parsed;
}

export function readAuthRemoveParams(value: unknown): AuthRemoveParams {
	if (value === undefined) return { provider: "openai" };
	if (typeof value !== "object" || value === null) {
		throw new Error("auth remove params must be an object");
	}
	const candidate = value as Record<string, unknown>;
	return { provider: readAuthProvider(candidate.provider ?? "openai") };
}

function readAuthProvider(value: unknown): string {
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new Error("auth provider must be a non-empty string");
	}
	return value;
}

export function readSendParams(value: unknown): SendParams {
	if (typeof value !== "object" || value === null) {
		throw new Error("send params must be an object");
	}
	const candidate = value as Record<string, unknown>;
	if (typeof candidate.prompt !== "string" || candidate.prompt.trim().length === 0) {
		throw new Error("send params require a non-empty prompt");
	}
	const params: SendParams = { prompt: candidate.prompt };
	const sessionId = candidate.sessionId ?? candidate.session_id;
	if (sessionId !== undefined) {
		if (typeof sessionId !== "string" || sessionId.trim().length === 0) {
			throw new Error("sessionId must be a non-empty string");
		}
		params.sessionId = sessionId;
	}
	if (candidate.skill !== undefined) {
		if (typeof candidate.skill !== "string" || candidate.skill.trim().length === 0) {
			throw new Error("skill must be a non-empty string");
		}
		params.skill = candidate.skill;
	}
	if (candidate.provider !== undefined) {
		if (typeof candidate.provider !== "string" || candidate.provider.trim().length === 0) {
			throw new Error("provider must be a non-empty string");
		}
		params.provider = candidate.provider;
	}
	if (candidate.model !== undefined) {
		if (typeof candidate.model !== "string" || candidate.model.trim().length === 0) {
			throw new Error("model must be a non-empty string");
		}
		params.model = candidate.model;
	}
	return params;
}

export function readSessionForkParams(value: unknown): SessionForkParams {
	if (typeof value !== "object" || value === null) {
		throw new Error("session fork params must be an object");
	}
	const candidate = value as Record<string, unknown>;
	const sourceSessionId = candidate.sourceSessionId ?? candidate.source_session_id;
	if (typeof sourceSessionId !== "string" || sourceSessionId.trim().length === 0) {
		throw new Error("session fork params require a non-empty sourceSessionId");
	}
	const params: SessionForkParams = { sourceSessionId };
	if (candidate.cwd !== undefined) {
		if (typeof candidate.cwd !== "string" || candidate.cwd.trim().length === 0) {
			throw new Error("session fork cwd must be a non-empty string");
		}
		params.cwd = candidate.cwd;
	}
	return params;
}

export function readSessionSearchParams(value: unknown): SessionSearchParams {
	if (typeof value !== "object" || value === null) {
		throw new Error("session search params must be an object");
	}
	const candidate = value as Record<string, unknown>;
	const query = candidate.query ?? candidate.q;
	if (typeof query !== "string" || query.trim().length === 0) {
		throw new Error("session search params require a non-empty query");
	}
	const params: SessionSearchParams = { query };
	if (candidate.limit !== undefined) {
		const limit = typeof candidate.limit === "string" ? Number.parseInt(candidate.limit, 10) : candidate.limit;
		if (typeof limit !== "number" || !Number.isInteger(limit) || limit <= 0) {
			throw new Error("session search limit must be a positive integer");
		}
		params.limit = limit;
	}
	return params;
}

export function readSkillAddParams(value: unknown): CreateClankySkillInput {
	if (typeof value !== "object" || value === null) {
		throw new Error("skill add params must be an object");
	}
	const candidate = value as Record<string, unknown>;
	if (typeof candidate.name !== "string" || candidate.name.trim().length === 0) {
		throw new Error("skill add params require a non-empty name");
	}
	const params: CreateClankySkillInput = { name: candidate.name };
	if (candidate.description !== undefined) {
		if (typeof candidate.description !== "string" || candidate.description.trim().length === 0) {
			throw new Error("skill description must be a non-empty string");
		}
		params.description = candidate.description;
	}
	if (candidate.body !== undefined) {
		if (typeof candidate.body !== "string" || candidate.body.trim().length === 0) {
			throw new Error("skill body must be a non-empty string");
		}
		params.body = candidate.body;
	}
	return params;
}

export function readSkillRemoveParams(value: unknown): SkillRemoveParams {
	if (typeof value !== "object" || value === null) {
		throw new Error("skill remove params must be an object");
	}
	const candidate = value as Record<string, unknown>;
	if (typeof candidate.name !== "string" || candidate.name.trim().length === 0) {
		throw new Error("skill remove params require a non-empty name");
	}
	return { name: candidate.name };
}

export function readTaskAddParams(value: unknown): CreateClankyTaskInput {
	if (typeof value !== "object" || value === null) {
		throw new Error("task add params must be an object");
	}
	const candidate = value as Record<string, unknown>;
	if (typeof candidate.title !== "string" || candidate.title.trim().length === 0) {
		throw new Error("task add params require a non-empty title");
	}
	const params: CreateClankyTaskInput = { title: candidate.title };
	addOptionalTaskStringParam(params, "description", candidate.description, "task description");
	addOptionalTaskStringParam(params, "sessionId", candidate.sessionId ?? candidate.session_id, "task sessionId");
	addOptionalTaskStringParam(
		params,
		"linearIssue",
		candidate.linearIssue ?? candidate.linear_issue,
		"task linearIssue",
	);
	addOptionalTaskStringParam(params, "source", candidate.source, "task source");
	if (candidate.status !== undefined) params.status = readTaskStatus(candidate.status);
	if (candidate.priority !== undefined) params.priority = readTaskPriority(candidate.priority);
	return params;
}

export function readTaskListParams(value: unknown): ListClankyTasksOptions {
	if (value === undefined) return {};
	if (typeof value !== "object" || value === null) {
		throw new Error("task list params must be an object");
	}
	const candidate = value as Record<string, unknown>;
	const params: ListClankyTasksOptions = {};
	const sessionId = candidate.sessionId ?? candidate.session_id;
	if (sessionId !== undefined) {
		if (typeof sessionId !== "string" || sessionId.trim().length === 0) {
			throw new Error("task list sessionId must be a non-empty string");
		}
		params.sessionId = sessionId;
	}
	const linearIssue = candidate.linearIssue ?? candidate.linear_issue;
	if (linearIssue !== undefined) {
		if (typeof linearIssue !== "string" || linearIssue.trim().length === 0) {
			throw new Error("task list linearIssue must be a non-empty string");
		}
		params.linearIssue = linearIssue;
	}
	if (candidate.status !== undefined) params.status = readTaskStatus(candidate.status);
	if (candidate.priority !== undefined) params.priority = readTaskPriority(candidate.priority);
	if (candidate.limit !== undefined) {
		const limit = typeof candidate.limit === "string" ? Number.parseInt(candidate.limit, 10) : candidate.limit;
		if (typeof limit !== "number" || !Number.isInteger(limit) || limit <= 0) {
			throw new Error("task list limit must be a positive integer");
		}
		params.limit = limit;
	}
	return params;
}

export function readTaskUpdateParams(value: unknown): UpdateClankyTaskInput {
	if (typeof value !== "object" || value === null) {
		throw new Error("task update params must be an object");
	}
	const candidate = value as Record<string, unknown>;
	if (typeof candidate.id !== "string" || candidate.id.trim().length === 0) {
		throw new Error("task update params require a non-empty id");
	}
	const params: UpdateClankyTaskInput = { id: candidate.id };
	if (candidate.title !== undefined) {
		if (typeof candidate.title !== "string" || candidate.title.trim().length === 0) {
			throw new Error("task title must be a non-empty string");
		}
		params.title = candidate.title;
	}
	addOptionalTaskStringParam(params, "description", candidate.description, "task description");
	addOptionalTaskStringParam(params, "sessionId", candidate.sessionId ?? candidate.session_id, "task sessionId");
	addOptionalTaskStringParam(
		params,
		"linearIssue",
		candidate.linearIssue ?? candidate.linear_issue,
		"task linearIssue",
	);
	addOptionalTaskStringParam(params, "source", candidate.source, "task source");
	if (candidate.status !== undefined) params.status = readTaskStatus(candidate.status);
	if (candidate.priority !== undefined) params.priority = readTaskPriority(candidate.priority);
	if (Object.keys(params).length === 1) throw new Error("task update params require at least one field");
	return params;
}

export function readExternalMcpCallParams(value: unknown): ExternalMcpCallParams {
	if (typeof value !== "object" || value === null) {
		throw new Error("mcp call params must be an object");
	}
	const candidate = value as Record<string, unknown>;
	if (typeof candidate.server !== "string" || candidate.server.trim().length === 0) {
		throw new Error("mcp call params require a non-empty server");
	}
	if (typeof candidate.tool !== "string" || candidate.tool.trim().length === 0) {
		throw new Error("mcp call params require a non-empty tool");
	}
	const params: ExternalMcpCallParams = { server: candidate.server, tool: candidate.tool };
	const args = candidate.arguments ?? candidate.args;
	if (args !== undefined) {
		if (typeof args !== "object" || args === null || Array.isArray(args)) {
			throw new Error("mcp call arguments must be an object");
		}
		params.arguments = args as Record<string, unknown>;
	}
	return params;
}

export function readLinearFlushParams(value: unknown): LinearFlushParams {
	if (value === undefined) return {};
	if (typeof value !== "object" || value === null) {
		throw new Error("linear flush params must be an object");
	}
	const candidate = value as Record<string, unknown>;
	const params: LinearFlushParams = {};
	if (candidate.limit !== undefined) {
		const limit = typeof candidate.limit === "string" ? Number.parseInt(candidate.limit, 10) : candidate.limit;
		if (typeof limit !== "number" || !Number.isInteger(limit) || limit <= 0) {
			throw new Error("linear flush limit must be a positive integer");
		}
		params.limit = limit;
	}
	return params;
}

export function readLinearCreateParams(value: unknown): LinearCreateIssueInput {
	if (typeof value !== "object" || value === null) {
		throw new Error("linear create params must be an object");
	}
	const candidate = value as Record<string, unknown>;
	const teamId = candidate.teamId ?? candidate.team_id;
	if (typeof teamId !== "string" || teamId.trim().length === 0) {
		throw new Error("linear create params require a non-empty teamId");
	}
	if (typeof candidate.title !== "string" || candidate.title.trim().length === 0) {
		throw new Error("linear create params require a non-empty title");
	}
	const params: LinearCreateIssueInput = { teamId, title: candidate.title };
	addOptionalLinearCreateStringParam(params, "description", candidate.description, "linear create description");
	addOptionalLinearCreateStringParam(
		params,
		"assigneeId",
		candidate.assigneeId ?? candidate.assignee_id,
		"linear create assigneeId",
	);
	addOptionalLinearCreateStringParam(
		params,
		"projectId",
		candidate.projectId ?? candidate.project_id,
		"linear create projectId",
	);
	addOptionalLinearCreateStringParam(
		params,
		"stateId",
		candidate.stateId ?? candidate.state_id,
		"linear create stateId",
	);
	if (candidate.priority !== undefined) {
		if (typeof candidate.priority !== "number" || !Number.isInteger(candidate.priority)) {
			throw new Error("linear create priority must be an integer");
		}
		params.priority = candidate.priority;
	}
	const labelIds = candidate.labelIds ?? candidate.label_ids;
	if (labelIds !== undefined) params.labelIds = readStringArray(labelIds, "linear create labelIds");
	return params;
}

export function readLinearLinkParams(value: unknown): CreateLinearLinkInput {
	if (typeof value !== "object" || value === null) {
		throw new Error("linear link params must be an object");
	}
	const candidate = value as Record<string, unknown>;
	const issueId = candidate.issueId ?? candidate.issue_id;
	if (typeof issueId !== "string" || issueId.trim().length === 0) {
		throw new Error("linear link params require a non-empty issueId");
	}
	const params: CreateLinearLinkInput = { issueId };
	const sessionId = candidate.sessionId ?? candidate.session_id;
	if (sessionId !== undefined) {
		if (typeof sessionId !== "string" || sessionId.trim().length === 0) {
			throw new Error("linear link sessionId must be a non-empty string");
		}
		params.sessionId = sessionId;
	}
	const taskId = candidate.taskId ?? candidate.task_id;
	if (taskId !== undefined) {
		if (typeof taskId !== "string" || taskId.trim().length === 0) {
			throw new Error("linear link taskId must be a non-empty string");
		}
		params.taskId = taskId;
	}
	if (candidate.note !== undefined) {
		if (typeof candidate.note !== "string" || candidate.note.trim().length === 0) {
			throw new Error("linear link note must be a non-empty string");
		}
		params.note = candidate.note;
	}
	return params;
}

export function readCronAddParams(value: unknown): CreateCronJobInput {
	if (typeof value !== "object" || value === null) {
		throw new Error("cron add params must be an object");
	}
	const candidate = value as Record<string, unknown>;
	if (typeof candidate.schedule !== "string" || candidate.schedule.trim().length === 0) {
		throw new Error("cron add params require a non-empty schedule");
	}
	if (typeof candidate.prompt !== "string" || candidate.prompt.trim().length === 0) {
		throw new Error("cron add params require a non-empty prompt");
	}
	const params: CreateCronJobInput = {
		schedule: candidate.schedule,
		prompt: candidate.prompt,
	};
	if (candidate.deliver !== undefined) {
		if (typeof candidate.deliver !== "string" || candidate.deliver.trim().length === 0) {
			throw new Error("cron delivery target must be a non-empty string");
		}
		params.deliver = candidate.deliver as CronDelivery;
	}
	if (candidate.enabled !== undefined) {
		if (typeof candidate.enabled !== "boolean") throw new Error("cron enabled must be a boolean");
		params.enabled = candidate.enabled;
	}
	const timeoutSeconds = candidate.timeoutSeconds ?? candidate.timeout_seconds;
	if (timeoutSeconds !== undefined) {
		if (typeof timeoutSeconds !== "number" || !Number.isInteger(timeoutSeconds)) {
			throw new Error("cron timeoutSeconds must be an integer");
		}
		params.timeoutSeconds = timeoutSeconds;
	}
	if (candidate.skill !== undefined) {
		if (typeof candidate.skill !== "string" || candidate.skill.trim().length === 0) {
			throw new Error("cron skill must be a non-empty string");
		}
		params.skill = candidate.skill;
	}
	if (candidate.provider !== undefined) {
		if (typeof candidate.provider !== "string" || candidate.provider.trim().length === 0) {
			throw new Error("cron provider must be a non-empty string");
		}
		params.provider = candidate.provider;
	}
	if (candidate.model !== undefined) {
		if (typeof candidate.model !== "string" || candidate.model.trim().length === 0) {
			throw new Error("cron model must be a non-empty string");
		}
		params.model = candidate.model;
	}
	if (candidate.workdir !== undefined) {
		if (typeof candidate.workdir !== "string" || candidate.workdir.trim().length === 0) {
			throw new Error("cron workdir must be a non-empty string");
		}
		params.workdir = candidate.workdir;
	}
	const idempotencyKey = candidate.idempotencyKey ?? candidate.idempotency_key;
	if (idempotencyKey !== undefined) {
		if (typeof idempotencyKey !== "string" || idempotencyKey.trim().length === 0) {
			throw new Error("cron idempotencyKey must be a non-empty string");
		}
		params.idempotencyKey = idempotencyKey;
	}
	return params;
}

export function readCronJobIdParams(value: unknown): CronJobIdParams {
	if (typeof value !== "object" || value === null) {
		throw new Error("cron job params must be an object");
	}
	const candidate = value as Record<string, unknown>;
	const jobId = candidate.jobId ?? candidate.job_id;
	if (typeof jobId !== "string" || jobId.trim().length === 0) {
		throw new Error("cron job params require a non-empty jobId");
	}
	return { jobId };
}

function readStringArray(value: unknown, label: string): string[] {
	if (!Array.isArray(value) || !value.every((item) => typeof item === "string" && item.trim().length > 0)) {
		throw new Error(`${label} must be an array of non-empty strings`);
	}
	return value;
}

function addOptionalLinearCreateStringParam(
	target: LinearCreateIssueInput,
	key: "description" | "assigneeId" | "projectId" | "stateId",
	value: unknown,
	label: string,
): void {
	if (value === undefined) return;
	if (typeof value !== "string" || value.trim().length === 0) throw new Error(`${label} must be a non-empty string`);
	target[key] = value;
}

function addOptionalTaskStringParam(
	target: CreateClankyTaskInput | UpdateClankyTaskInput,
	key: "description" | "sessionId" | "linearIssue" | "source",
	value: unknown,
	label: string,
): void {
	if (value === undefined) return;
	if (typeof value !== "string" || value.trim().length === 0) throw new Error(`${label} must be a non-empty string`);
	target[key] = value;
}

function readTaskStatus(value: unknown): NonNullable<CreateClankyTaskInput["status"]> {
	if (value === "open" || value === "in_progress" || value === "done" || value === "cancelled") return value;
	throw new Error("task status must be one of: open, in_progress, done, cancelled");
}

function readTaskPriority(value: unknown): NonNullable<CreateClankyTaskInput["priority"]> {
	if (value === "low" || value === "normal" || value === "high") return value;
	throw new Error("task priority must be one of: low, normal, high");
}
