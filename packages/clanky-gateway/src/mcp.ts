import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod/v4";
import { requestGateway } from "./client.ts";
import type { GatewayMethod } from "./protocol.ts";

export interface StartMcpServerOptions {
	socketFile: string;
}

const LONG_RUNNING_TIMEOUT_MS = 10 * 60 * 1000;

export async function startMcpServer(options: StartMcpServerOptions): Promise<void> {
	const server = new McpServer({
		name: "clanky",
		version: "0.0.0",
	});

	server.registerTool(
		"clanky.status",
		{
			title: "Clanky Status",
			description: "Return daemon health, live session count, and cron job counts.",
		},
		async () => toToolResult(await callGateway(options, "status")),
	);

	server.registerTool(
		"memory.status",
		{
			title: "Memory Status",
			description: "Return Clanky memory counts, consent state, and self-memory file path.",
		},
		async () => toToolResult(await callGateway(options, "memory.status")),
	);

	server.registerTool(
		"memory.search",
		{
			title: "Search Memory",
			description: "Search source-grounded Clanky memory atoms.",
			inputSchema: {
				query: z.string().min(1).optional(),
				q: z.string().min(1).optional(),
				scope: z.enum(["user", "dm", "guild", "channel", "project", "agent"]).optional(),
				subjectId: z.string().min(1).optional(),
				subject_id: z.string().min(1).optional(),
				limit: z.number().int().positive().optional(),
			},
		},
		async (args) =>
			toToolResult(
				await callGateway(options, "memory.search", {
					...optionalProperties({
						query: args.query ?? args.q,
						scope: args.scope,
						subjectId: args.subjectId ?? args.subject_id,
						limit: args.limit,
					}),
				}),
			),
	);

	server.registerTool(
		"memory.remember",
		{
			title: "Remember Memory",
			description: "Store a source-grounded Clanky memory atom when policy and confirmation allow it.",
			inputSchema: {
				scope: z.enum(["user", "dm", "guild", "channel", "project", "agent"]).optional(),
				subjectId: z.string().min(1).optional(),
				subject_id: z.string().min(1).optional(),
				type: z.enum(["preference", "fact", "decision", "commitment", "lesson", "skill_hint"]).optional(),
				claim: z.string().min(1),
				sourceEventIds: z.array(z.string().min(1)).optional(),
				source_event_ids: z.array(z.string().min(1)).optional(),
				sourceText: z.string().min(1).optional(),
				source_text: z.string().min(1).optional(),
				confidence: z.number().min(0).max(1).optional(),
				sensitivity: z.enum(["public", "personal", "sensitive", "secret"]).optional(),
				ttlDays: z.number().int().positive().optional(),
				ttl_days: z.number().int().positive().optional(),
				confirmed: z.boolean().optional(),
			},
		},
		async (args) =>
			toToolResult(
				await callGateway(options, "memory.remember", {
					claim: args.claim,
					...optionalProperties({
						scope: args.scope,
						subjectId: args.subjectId ?? args.subject_id,
						type: args.type,
						sourceEventIds: args.sourceEventIds ?? args.source_event_ids,
						sourceText: args.sourceText ?? args.source_text,
						confidence: args.confidence,
						sensitivity: args.sensitivity,
						ttlDays: args.ttlDays ?? args.ttl_days,
						confirmed: args.confirmed,
					}),
				}),
			),
	);

	server.registerTool(
		"memory.forget",
		{
			title: "Forget Memory",
			description: "Delete a Clanky memory atom by id or clear a subject scope.",
			inputSchema: {
				id: z.string().min(1).optional(),
				scope: z.enum(["user", "dm", "guild", "channel", "project", "agent"]).optional(),
				subjectId: z.string().min(1).optional(),
				subject_id: z.string().min(1).optional(),
			},
		},
		async (args) =>
			toToolResult(
				await callGateway(options, "memory.forget", {
					...optionalProperties({
						id: args.id,
						scope: args.scope,
						subjectId: args.subjectId ?? args.subject_id,
					}),
				}),
			),
	);

	server.registerTool(
		"memory.export",
		{
			title: "Export Memory",
			description: "Export Clanky self memory, atoms, events, and consent state.",
		},
		async () => toToolResult(await callGateway(options, "memory.export")),
	);

	server.registerTool(
		"memory.consent",
		{
			title: "Set Memory Consent",
			description: "Enable or disable memory for a subject scope.",
			inputSchema: {
				scope: z.enum(["user", "dm", "guild", "channel", "project", "agent"]),
				subjectId: z.string().min(1).optional(),
				subject_id: z.string().min(1).optional(),
				enabled: z.boolean(),
				mode: z.enum(["mention", "dm", "channel", "server", "off"]).optional(),
				retentionDays: z.number().int().positive().optional(),
				retention_days: z.number().int().positive().optional(),
				notice: z.string().min(1).optional(),
			},
		},
		async (args) =>
			toToolResult(
				await callGateway(options, "memory.consent", {
					scope: args.scope,
					enabled: args.enabled,
					...optionalProperties({
						subjectId: args.subjectId ?? args.subject_id,
						mode: args.mode,
						retentionDays: args.retentionDays ?? args.retention_days,
						notice: args.notice,
					}),
				}),
			),
	);

	server.registerTool(
		"session.send",
		{
			title: "Send Session Prompt",
			description: "Send a prompt to a new or existing Clanky/Pi session.",
			inputSchema: {
				prompt: z.string().min(1),
				sessionId: z.string().min(1).optional(),
				session_id: z.string().min(1).optional(),
				skill: z.string().min(1).optional(),
				provider: z.string().min(1).optional(),
				model: z.string().min(1).optional(),
			},
		},
		async (args) =>
			toToolResult(
				await callGateway(
					options,
					"send",
					sendParams(args.prompt, args.sessionId ?? args.session_id, args.skill, args.provider, args.model),
					{
						timeoutMs: LONG_RUNNING_TIMEOUT_MS,
					},
				),
			),
	);

	server.registerTool(
		"session.list",
		{
			title: "List Sessions",
			description: "List live and persisted Clanky sessions.",
		},
		async () => toToolResult(await callGateway(options, "session.list")),
	);

	server.registerTool(
		"session.fork",
		{
			title: "Fork Session",
			description: "Fork an existing Clanky/Pi session into a new session.",
			inputSchema: {
				sourceSessionId: z.string().min(1).optional(),
				source_session_id: z.string().min(1).optional(),
				cwd: z.string().min(1).optional(),
			},
		},
		async (args) =>
			toToolResult(
				await callGateway(options, "session.fork", {
					...optionalProperties({
						sourceSessionId: args.sourceSessionId ?? args.source_session_id,
						cwd: args.cwd,
					}),
				}),
			),
	);

	server.registerTool(
		"session.search",
		{
			title: "Search Sessions",
			description: "Search indexed Clanky session text across persisted sessions.",
			inputSchema: {
				query: z.string().min(1).optional(),
				q: z.string().min(1).optional(),
				limit: z.number().int().positive().optional(),
			},
		},
		async (args) =>
			toToolResult(
				await callGateway(options, "session.search", {
					...optionalProperties({ query: args.query ?? args.q }),
					...optionalProperties({ limit: args.limit }),
				}),
			),
	);

	server.registerTool(
		"skill.list",
		{
			title: "List Skills",
			description: "List bundled, user, and profile skills visible to Clanky.",
		},
		async () => toToolResult(await callGateway(options, "skill.list")),
	);

	server.registerTool(
		"skill.usage",
		{
			title: "List Skill Usage",
			description: "List Clanky skill usage counts and last-use metadata.",
		},
		async () => toToolResult(await callGateway(options, "skill.usage")),
	);

	server.registerTool(
		"skill.add",
		{
			title: "Add Skill",
			description: "Create a profile-local Clanky skill.",
			inputSchema: {
				name: z.string().min(1),
				description: z.string().min(1).optional(),
				body: z.string().min(1).optional(),
			},
		},
		async (args) =>
			toToolResult(
				await callGateway(options, "skill.add", {
					name: args.name,
					...optionalProperties({
						description: args.description,
						body: args.body,
					}),
				}),
			),
	);

	server.registerTool(
		"skill.remove",
		{
			title: "Remove Skill",
			description: "Remove a profile-local Clanky skill.",
			inputSchema: {
				name: z.string().min(1),
			},
		},
		async (args) => toToolResult(await callGateway(options, "skill.remove", { name: args.name })),
	);

	server.registerTool(
		"task.list",
		{
			title: "List Clanky Tasks",
			description: "List profile-local Clanky task ledger entries.",
			inputSchema: {
				sessionId: z.string().min(1).optional(),
				session_id: z.string().min(1).optional(),
				linearIssue: z.string().min(1).optional(),
				linear_issue: z.string().min(1).optional(),
				status: z.enum(["open", "in_progress", "done", "cancelled"]).optional(),
				priority: z.enum(["low", "normal", "high"]).optional(),
				limit: z.number().int().positive().optional(),
			},
		},
		async (args) =>
			toToolResult(
				await callGateway(options, "task.list", {
					...optionalProperties({
						sessionId: args.sessionId ?? args.session_id,
						linearIssue: args.linearIssue ?? args.linear_issue,
						status: args.status,
						priority: args.priority,
						limit: args.limit,
					}),
				}),
			),
	);

	server.registerTool(
		"task.add",
		{
			title: "Add Clanky Task",
			description: "Create a profile-local Clanky task ledger entry.",
			inputSchema: {
				title: z.string().min(1),
				description: z.string().min(1).optional(),
				status: z.enum(["open", "in_progress", "done", "cancelled"]).optional(),
				priority: z.enum(["low", "normal", "high"]).optional(),
				sessionId: z.string().min(1).optional(),
				session_id: z.string().min(1).optional(),
				linearIssue: z.string().min(1).optional(),
				linear_issue: z.string().min(1).optional(),
			},
		},
		async (args) =>
			toToolResult(
				await callGateway(options, "task.add", {
					title: args.title,
					source: "mcp",
					...optionalProperties({
						description: args.description,
						status: args.status,
						priority: args.priority,
						sessionId: args.sessionId ?? args.session_id,
						linearIssue: args.linearIssue ?? args.linear_issue,
					}),
				}),
			),
	);

	server.registerTool(
		"task.update",
		{
			title: "Update Clanky Task",
			description: "Update a profile-local Clanky task ledger entry.",
			inputSchema: {
				id: z.string().min(1),
				title: z.string().min(1).optional(),
				description: z.string().min(1).optional(),
				status: z.enum(["open", "in_progress", "done", "cancelled"]).optional(),
				priority: z.enum(["low", "normal", "high"]).optional(),
				sessionId: z.string().min(1).optional(),
				session_id: z.string().min(1).optional(),
				linearIssue: z.string().min(1).optional(),
				linear_issue: z.string().min(1).optional(),
			},
		},
		async (args) =>
			toToolResult(
				await callGateway(options, "task.update", {
					id: args.id,
					...optionalProperties({
						title: args.title,
						description: args.description,
						status: args.status,
						priority: args.priority,
						sessionId: args.sessionId ?? args.session_id,
						linearIssue: args.linearIssue ?? args.linear_issue,
					}),
				}),
			),
	);

	server.registerTool(
		"mcp.list",
		{
			title: "List External MCP Servers",
			description: "List external MCP servers configured in the Clanky daemon.",
		},
		async () => toToolResult(await callGateway(options, "mcp.list")),
	);

	server.registerTool(
		"mcp.call",
		{
			title: "Call External MCP Tool",
			description: "Call a tool on an external MCP server configured in the Clanky daemon.",
			inputSchema: {
				server: z.string().min(1),
				tool: z.string().min(1),
				arguments: z.object({}).catchall(z.unknown()).optional(),
			},
		},
		async (args) =>
			toToolResult(
				await callGateway(options, "mcp.call", {
					server: args.server,
					tool: args.tool,
					...optionalProperties({ arguments: args.arguments }),
				}),
			),
	);

	server.registerTool(
		"linear.list",
		{
			title: "List Linear Links",
			description: "List persisted Linear issue links for this Clanky profile.",
		},
		async () => toToolResult(await callGateway(options, "linear.list")),
	);

	server.registerTool(
		"linear.link",
		{
			title: "Link Linear Issue",
			description: "Persist a link between a Linear issue and a Clanky session or swarm task.",
			inputSchema: {
				issueId: z.string().min(1).optional(),
				issue_id: z.string().min(1).optional(),
				sessionId: z.string().min(1).optional(),
				session_id: z.string().min(1).optional(),
				taskId: z.string().min(1).optional(),
				task_id: z.string().min(1).optional(),
				note: z.string().min(1).optional(),
			},
		},
		async (args) =>
			toToolResult(
				await callGateway(options, "linear.link", {
					issueId: args.issueId ?? args.issue_id,
					...optionalProperties({
						sessionId: args.sessionId ?? args.session_id,
						taskId: args.taskId ?? args.task_id,
						note: args.note,
					}),
				}),
			),
	);

	server.registerTool(
		"linear.create",
		{
			title: "Create Linear Issue",
			description: "Create a Linear issue using configured Linear credentials.",
			inputSchema: {
				teamId: z.string().min(1).optional(),
				team_id: z.string().min(1).optional(),
				title: z.string().min(1),
				description: z.string().min(1).optional(),
				assigneeId: z.string().min(1).optional(),
				assignee_id: z.string().min(1).optional(),
				projectId: z.string().min(1).optional(),
				project_id: z.string().min(1).optional(),
				stateId: z.string().min(1).optional(),
				state_id: z.string().min(1).optional(),
				priority: z.number().int().optional(),
				labelIds: z.array(z.string().min(1)).optional(),
				label_ids: z.array(z.string().min(1)).optional(),
			},
		},
		async (args) =>
			toToolResult(
				await callGateway(options, "linear.create", {
					teamId: args.teamId ?? args.team_id,
					title: args.title,
					...optionalProperties({
						description: args.description,
						assigneeId: args.assigneeId ?? args.assignee_id,
						projectId: args.projectId ?? args.project_id,
						stateId: args.stateId ?? args.state_id,
						priority: args.priority,
						labelIds: args.labelIds ?? args.label_ids,
					}),
				}),
			),
	);

	server.registerTool(
		"linear.outbox",
		{
			title: "List Linear Outbox",
			description: "List pending Linear updates recorded by Clanky.",
		},
		async () => toToolResult(await callGateway(options, "linear.outbox")),
	);

	server.registerTool(
		"linear.flush",
		{
			title: "Flush Linear Outbox",
			description: "Post pending Linear outbox comments using LINEAR_API_KEY or LINEAR_ACCESS_TOKEN.",
			inputSchema: {
				limit: z.number().int().positive().optional(),
			},
		},
		async (args) =>
			toToolResult(
				await callGateway(options, "linear.flush", {
					...optionalProperties({ limit: args.limit }),
				}),
			),
	);

	server.registerTool(
		"cron.list",
		{
			title: "List Cron Jobs",
			description: "List configured Clanky cron jobs.",
		},
		async () => toToolResult(await callGateway(options, "cron.list")),
	);

	server.registerTool(
		"cron.add",
		{
			title: "Add Cron Job",
			description: "Create a Clanky cron job.",
			inputSchema: {
				schedule: z.string().min(1),
				prompt: z.string().min(1),
				deliver: z.string().min(1).optional(),
				enabled: z.boolean().optional(),
				timeoutSeconds: z.number().int().positive().optional(),
				timeout_seconds: z.number().int().positive().optional(),
				skill: z.string().min(1).optional(),
				provider: z.string().min(1).optional(),
				model: z.string().min(1).optional(),
				workdir: z.string().min(1).optional(),
				idempotencyKey: z.string().min(1).optional(),
				idempotency_key: z.string().min(1).optional(),
			},
		},
		async (args) =>
			toToolResult(
				await callGateway(options, "cron.add", {
					schedule: args.schedule,
					prompt: args.prompt,
					...optionalProperties({
						deliver: args.deliver,
						enabled: args.enabled,
						timeoutSeconds: args.timeoutSeconds ?? args.timeout_seconds,
						skill: args.skill,
						provider: args.provider,
						model: args.model,
						workdir: args.workdir,
						idempotencyKey: args.idempotencyKey ?? args.idempotency_key,
					}),
				}),
			),
	);

	server.registerTool(
		"cron.remove",
		{
			title: "Remove Cron Job",
			description: "Remove a Clanky cron job.",
			inputSchema: {
				jobId: z.string().min(1).optional(),
				job_id: z.string().min(1).optional(),
			},
		},
		async (args) =>
			toToolResult(
				await callGateway(options, "cron.remove", {
					...optionalProperties({ jobId: args.jobId ?? args.job_id }),
				}),
			),
	);

	server.registerTool(
		"cron.enable",
		{
			title: "Enable Cron Job",
			description: "Enable a Clanky cron job.",
			inputSchema: {
				jobId: z.string().min(1).optional(),
				job_id: z.string().min(1).optional(),
			},
		},
		async (args) =>
			toToolResult(
				await callGateway(options, "cron.enable", {
					...optionalProperties({ jobId: args.jobId ?? args.job_id }),
				}),
			),
	);

	server.registerTool(
		"cron.disable",
		{
			title: "Disable Cron Job",
			description: "Disable a Clanky cron job.",
			inputSchema: {
				jobId: z.string().min(1).optional(),
				job_id: z.string().min(1).optional(),
			},
		},
		async (args) =>
			toToolResult(
				await callGateway(options, "cron.disable", {
					...optionalProperties({ jobId: args.jobId ?? args.job_id }),
				}),
			),
	);

	server.registerTool(
		"cron.run_now",
		{
			title: "Run Cron Job Now",
			description: "Run a Clanky cron job immediately.",
			inputSchema: {
				jobId: z.string().min(1).optional(),
				job_id: z.string().min(1).optional(),
			},
		},
		async (args) =>
			toToolResult(
				await callGateway(
					options,
					"cron.run_now",
					{ ...optionalProperties({ jobId: args.jobId ?? args.job_id }) },
					{ timeoutMs: LONG_RUNNING_TIMEOUT_MS },
				),
			),
	);

	server.registerTool(
		"swarm.status",
		{
			title: "Swarm Status",
			description: "Return Clanky's swarm leader configuration and lifecycle state.",
		},
		async () => toToolResult(await callGateway(options, "swarm.status")),
	);

	server.registerTool(
		"swarm.peers",
		{
			title: "List Swarm Peers",
			description: "List active peers visible to the Clanky swarm leader.",
		},
		async () => toToolResult(await callGateway(options, "swarm.peers")),
	);

	server.registerTool(
		"swarm.tasks",
		{
			title: "List Swarm Tasks",
			description: "List tasks visible to the Clanky swarm leader.",
		},
		async () => toToolResult(await callGateway(options, "swarm.tasks")),
	);

	server.registerTool(
		"swarm.snapshot",
		{
			title: "Swarm Snapshot",
			description: "Return peers and tasks visible to the Clanky swarm leader.",
		},
		async () => toToolResult(await callGateway(options, "swarm.snapshot")),
	);

	server.registerTool(
		"swarm.file_lock",
		{
			title: "Inspect Swarm File Lock",
			description: "Read the active swarm edit lock for a file path.",
			inputSchema: {
				file: z.string().min(1).optional(),
				path: z.string().min(1).optional(),
			},
		},
		async (args) =>
			toToolResult(
				await callGateway(options, "swarm.file_lock", {
					...optionalProperties({ file: args.file ?? args.path }),
				}),
			),
	);

	server.registerTool(
		"swarm.message",
		{
			title: "Message Swarm Peer",
			description: "Send a durable message to a swarm peer and optionally wake its workspace.",
			inputSchema: {
				recipient: z.string().min(1),
				message: z.string().min(1),
				taskId: z.string().min(1).optional(),
				task_id: z.string().min(1).optional(),
				nudge: z.boolean().optional(),
				force: z.boolean().optional(),
			},
		},
		async (args) =>
			toToolResult(
				await callGateway(options, "swarm.message", {
					recipient: args.recipient,
					message: args.message,
					...optionalProperties({
						taskId: args.taskId ?? args.task_id,
						nudge: args.nudge,
						force: args.force,
					}),
				}),
			),
	);

	server.registerTool(
		"swarm.complete",
		{
			title: "Complete Swarm Task",
			description: "Complete a claimed swarm task with structured handoff details.",
			inputSchema: {
				taskId: z.string().min(1).optional(),
				task_id: z.string().min(1).optional(),
				status: z.enum(["done", "failed", "cancelled"]).optional(),
				summary: z.string().min(1),
				filesChanged: z.array(z.string().min(1)).optional(),
				files_changed: z.array(z.string().min(1)).optional(),
				tests: z
					.array(
						z.object({
							command: z.string().min(1).optional(),
							status: z.enum(["passed", "failed", "skipped", "unknown"]),
							notes: z.string().min(1).optional(),
						}),
					)
					.optional(),
				trackerUpdate: z.union([z.string(), z.object({}).catchall(z.unknown())]).optional(),
				tracker_update: z.union([z.string(), z.object({}).catchall(z.unknown())]).optional(),
				trackerUpdateSkipped: z.union([z.string(), z.object({}).catchall(z.unknown())]).optional(),
				tracker_update_skipped: z.union([z.string(), z.object({}).catchall(z.unknown())]).optional(),
				followups: z.array(z.string().min(1)).optional(),
			},
		},
		async (args) =>
			toToolResult(
				await callGateway(options, "swarm.complete", {
					taskId: args.taskId ?? args.task_id,
					summary: args.summary,
					...optionalProperties({
						status: args.status,
						filesChanged: args.filesChanged ?? args.files_changed,
						tests: args.tests,
						trackerUpdate: args.trackerUpdate ?? args.tracker_update,
						trackerUpdateSkipped: args.trackerUpdateSkipped ?? args.tracker_update_skipped,
						followups: args.followups,
					}),
				}),
			),
	);

	server.registerTool(
		"swarm.dispatch",
		{
			title: "Dispatch Swarm Task",
			description: "Delegate tracked work to the Clanky swarm leader.",
			inputSchema: {
				title: z.string().min(1),
				type: z.enum(["implement", "fix", "review", "research"]),
				description: z.string().min(1),
				files: z.array(z.string().min(1)).optional(),
				spawn: z.boolean().optional(),
				waitForCompletion: z.boolean().optional(),
				wait_for_completion: z.boolean().optional(),
				provider: z.string().min(1).optional(),
				model: z.string().min(1).optional(),
				linearIssue: z.string().min(1).optional(),
				linear_issue: z.string().min(1).optional(),
				idempotencyKey: z.string().min(1).optional(),
				idempotency_key: z.string().min(1).optional(),
			},
		},
		async (args) =>
			toToolResult(
				await callGateway(options, "swarm.dispatch", {
					title: args.title,
					type: args.type,
					description: args.description,
					...optionalProperties({
						files: args.files,
						spawn: args.spawn,
						waitForCompletion: args.waitForCompletion ?? args.wait_for_completion,
						provider: args.provider,
						model: args.model,
						linearIssue: args.linearIssue ?? args.linear_issue,
						idempotencyKey: args.idempotencyKey ?? args.idempotency_key,
					}),
				}),
			),
	);

	await server.connect(new StdioServerTransport());
}

async function callGateway(
	options: StartMcpServerOptions,
	method: GatewayMethod,
	params?: unknown,
	requestOptions: { timeoutMs?: number } = {},
): Promise<unknown> {
	const request: Parameters<typeof requestGateway>[0] = {
		socketFile: options.socketFile,
		method,
		params,
	};
	if (requestOptions.timeoutMs !== undefined) request.timeoutMs = requestOptions.timeoutMs;
	return await requestGateway(request);
}

function toToolResult(value: unknown): CallToolResult {
	return {
		content: [{ type: "text", text: JSON.stringify(value, null, "\t") }],
		structuredContent: toStructuredContent(value),
	};
}

function toStructuredContent(value: unknown): Record<string, unknown> {
	if (typeof value === "object" && value !== null && !Array.isArray(value)) return value as Record<string, unknown>;
	return { value };
}

function optionalProperties(values: Record<string, unknown>): Record<string, unknown> {
	const result: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(values)) {
		if (value !== undefined) result[key] = value;
	}
	return result;
}

function sendParams(
	prompt: string,
	sessionId: string | undefined,
	skill: string | undefined,
	provider: string | undefined,
	model: string | undefined,
): { prompt: string; sessionId?: string; skill?: string; provider?: string; model?: string } {
	const params: { prompt: string; sessionId?: string; skill?: string; provider?: string; model?: string } = { prompt };
	if (sessionId !== undefined) params.sessionId = sessionId;
	if (skill !== undefined) params.skill = skill;
	if (provider !== undefined) params.provider = provider;
	if (model !== undefined) params.model = model;
	return params;
}
