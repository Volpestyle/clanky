import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type ClankyAgentToolHandlers,
	createClankyExtensionFactories,
	createClankyToolDefinitions,
	type ExternalMcpCallToolInput,
	type LinearCreateIssueToolInput,
	type LinearLinkToolInput,
	type ScheduleCronToolInput,
	type SessionIndexMessageInput,
	SessionRegistry,
	type SwarmCompleteToolInput,
	type SwarmDispatchToolInput,
	type SwarmFileLockToolInput,
	type SwarmMessageToolInput,
	type TaskCreateToolInput,
} from "@clanky/core";
import type {
	BeforeAgentStartEvent,
	BeforeAgentStartEventResult,
	BeforeProviderRequestEvent,
	BeforeProviderRequestEventResult,
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	ExtensionHandler,
	RegisteredCommand,
	ToolCallEvent,
	ToolCallEventResult,
	ToolDefinition,
	ToolResultEvent,
} from "@earendil-works/pi-coding-agent";

interface TestMessageEndEvent {
	type: "message_end";
	message: {
		role: "user" | "assistant" | "toolResult";
		content: unknown;
		timestamp?: number;
	};
}

type TestMessageEndHandler = (event: TestMessageEndEvent, ctx: ExtensionContext) => Promise<unknown> | unknown;

const calls: string[] = [];
const indexedMessages: SessionIndexMessageInput[] = [];
const providerPayloads: unknown[] = [];
const handlers: ClankyAgentToolHandlers = {
	scheduleCron: async (input) => {
		calls.push(`schedule:${input.schedule}:${input.prompt}`);
		return { scheduled: true, input };
	},
	swarmDispatch: async (input) => {
		calls.push(`dispatch:${input.type}:${input.title}`);
		return { taskId: "task-tool", input };
	},
	swarmStatus: async () => {
		calls.push("status");
		return { state: "booted" };
	},
	swarmFileLock: async (input) => {
		calls.push(`file-lock:${input.path}`);
		return { blocked: input.path.includes("locked") };
	},
	swarmMessage: async (input) => {
		calls.push(`message:${input.recipient}:${input.message}`);
		return { ok: true, input };
	},
	swarmComplete: async (input) => {
		calls.push(`complete:${input.taskId}:${input.summary}`);
		return { ok: true, input };
	},
	linearLink: async (input) => {
		calls.push(`linear:${input.issueId}:${input.sessionId ?? input.taskId ?? "none"}`);
		return { link: input };
	},
	linearCreateIssue: async (input) => {
		calls.push(`linear-create:${input.teamId}:${input.title}`);
		return { issue: { issueId: "issue-tool", identifier: "PROJ-100", ...input } };
	},
	externalMcpCall: async (input) => {
		calls.push(`mcp-call:${input.server}:${input.tool}`);
		return { result: { ok: true, input } };
	},
	taskCreate: async (input) => {
		calls.push(`task:${input.title}:${input.sessionId ?? "none"}`);
		return { task: { id: "task-created", ...input } };
	},
	swarmSnapshotForPrompt: async (input) => {
		calls.push(`snapshot:${input.sessionId}`);
		return { ok: true, tasks: [{ id: "task-tool" }] };
	},
	mirrorToolResult: async (input) => {
		calls.push(`mirror:${input.toolName}:${input.toolCallId}`);
		return { ok: true };
	},
	beforeProviderRequest: async (input) => {
		calls.push(`provider:${input.sessionId}`);
		providerPayloads.push(input.payload);
		return { replaced: true, original: input.payload };
	},
	checkSwarmFileLock: async (input) => {
		calls.push(`hook:${input.toolName}:${input.path}`);
		if (input.path.includes("locked")) return { blocked: true, reason: `locked ${input.path}` };
		return { blocked: false };
	},
	indexMessage: async (input) => {
		indexedMessages.push(input);
	},
	listCron: async () => {
		calls.push("cron-command");
		return { jobs: [] };
	},
	externalMcpStatus: async () => {
		calls.push("mcp-command");
		return { servers: [{ name: "faux", state: "booted" }] };
	},
	listSkills: async () => {
		calls.push("skills-command");
		return { skills: [] };
	},
	createSkill: async (input) => {
		calls.push(`skill-create:${input.name}`);
		return { name: input.name, filePath: `/skills/${input.name}/SKILL.md` };
	},
	profileStatus: async () => {
		calls.push("profile-command");
		return { profile: "default" };
	},
};

const tools = createClankyToolDefinitions(handlers);
assertToolNames(tools, [
	"schedule_cron",
	"swarm_dispatch",
	"swarm_status",
	"swarm_file_lock",
	"swarm_message",
	"swarm_complete",
	"mcp_call",
	"linear_create_issue",
	"linear_link",
	"task_create",
]);

const scheduleDetails = await executeTool(tools, "schedule_cron", {
	schedule: "every 1h",
	prompt: "Summarize",
	provider: "anthropic",
	model: "claude-opus-4-5",
	timeout_seconds: 600,
	idempotency_key: "agent-tools-cron-smoke",
} satisfies ScheduleCronToolInput);
const scheduleInput = recordProperty(scheduleDetails, "input");
if (scheduleInput.provider !== "anthropic" || scheduleInput.model !== "claude-opus-4-5") {
	throw new Error(`schedule_cron did not forward provider/model overrides: ${JSON.stringify(scheduleDetails)}`);
}
if (scheduleInput.timeoutSeconds !== 600 || scheduleInput.idempotencyKey !== "agent-tools-cron-smoke") {
	throw new Error(`schedule_cron did not normalize snake_case cron aliases: ${JSON.stringify(scheduleDetails)}`);
}
const dispatchDetails = await executeTool(tools, "swarm_dispatch", {
	title: "Implement a tool smoke",
	type: "implement",
	description: "Exercise model-facing dispatch tool.",
	files: ["README.md"],
	provider: "anthropic",
	model: "claude-opus-4-5",
	wait_for_completion: true,
	linear_issue: "PROJ-AGENT",
	idempotency_key: "agent-tools-swarm-smoke",
} satisfies SwarmDispatchToolInput);
const dispatchInput = recordProperty(dispatchDetails, "input");
if (dispatchInput.provider !== "anthropic" || dispatchInput.model !== "claude-opus-4-5") {
	throw new Error(`swarm_dispatch did not forward provider/model overrides: ${JSON.stringify(dispatchDetails)}`);
}
if (
	dispatchInput.waitForCompletion !== true ||
	dispatchInput.linearIssue !== "PROJ-AGENT" ||
	dispatchInput.idempotencyKey !== "agent-tools-swarm-smoke"
) {
	throw new Error(`swarm_dispatch did not normalize snake_case dispatch aliases: ${JSON.stringify(dispatchDetails)}`);
}
await executeTool(tools, "swarm_status", {});
await executeTool(tools, "swarm_file_lock", { path: "locked-file.ts" } satisfies SwarmFileLockToolInput);
await executeTool(tools, "swarm_message", {
	recipient: "peer-1",
	message: "status?",
	task_id: "task-tool",
} satisfies SwarmMessageToolInput);
const completeDetails = await executeTool(tools, "swarm_complete", {
	task_id: "task-tool",
	summary: "Done",
	files_changed: ["README.md"],
	tests: [{ status: "passed", command: "pnpm check" }],
	tracker_update_skipped: { reason: "No Linear credentials in agent-tools smoke." },
} satisfies SwarmCompleteToolInput);
const completeInput = recordProperty(completeDetails, "input");
if (completeInput.taskId !== "task-tool" || !Array.isArray(completeInput.filesChanged)) {
	throw new Error(`swarm_complete did not normalize task_id/files_changed aliases: ${JSON.stringify(completeDetails)}`);
}
const completeTrackerSkipped = recordProperty(completeInput, "trackerUpdateSkipped");
if (completeTrackerSkipped.reason !== "No Linear credentials in agent-tools smoke.") {
	throw new Error(`swarm_complete did not normalize tracker_update_skipped alias: ${JSON.stringify(completeDetails)}`);
}
for (const expected of ["status", "file-lock:locked-file.ts", "message:peer-1:status?", "complete:task-tool:Done"]) {
	if (!calls.includes(expected)) throw new Error(`Model-facing swarm tool handler was not invoked: ${expected}`);
}
await executeTool(tools, "mcp_call", {
	server: "faux",
	tool: "echo",
	arguments: { message: "hello" },
} satisfies ExternalMcpCallToolInput);
const linearCreateDetails = await executeTool(tools, "linear_create_issue", {
	team_id: "team-tool",
	title: "Create tracked work",
	description: "Filed from the model-facing tool smoke.",
	label_ids: ["label-tool"],
} satisfies LinearCreateIssueToolInput);
const createdIssue = recordProperty(linearCreateDetails, "issue");
if (createdIssue.teamId !== "team-tool" || !Array.isArray(createdIssue.labelIds)) {
	throw new Error(`linear_create_issue did not normalize snake_case aliases: ${JSON.stringify(linearCreateDetails)}`);
}
const linearDetails = await executeTool(tools, "linear_link", { issue_id: "PROJ-987" } satisfies LinearLinkToolInput);
const link = recordProperty(linearDetails, "link");
if (link.sessionId !== "session-tool") {
	throw new Error(`linear_link did not default to the active session id: ${JSON.stringify(linearDetails)}`);
}
const taskDetails = await executeTool(tools, "task_create", {
	title: "Track follow-up",
	linear_issue: "PROJ-987",
} satisfies TaskCreateToolInput);
const task = recordProperty(taskDetails, "task");
if (task.sessionId !== "session-tool" || task.linearIssue !== "PROJ-987") {
	throw new Error(`task_create did not normalize/default tracking fields: ${JSON.stringify(taskDetails)}`);
}

const toolCallHandlers: Array<ExtensionHandler<ToolCallEvent, ToolCallEventResult>> = [];
const beforeAgentStartHandlers: Array<ExtensionHandler<BeforeAgentStartEvent, BeforeAgentStartEventResult>> = [];
const beforeProviderRequestHandlers: Array<
	ExtensionHandler<BeforeProviderRequestEvent, BeforeProviderRequestEventResult>
> = [];
const toolResultHandlers: Array<ExtensionHandler<ToolResultEvent>> = [];
const messageEndHandlers: TestMessageEndHandler[] = [];
const commandRegistrations = new Map<string, Omit<RegisteredCommand, "name" | "sourceInfo">>();
const customEntries: Array<{ customType: string; data: unknown }> = [];
const fakeApi = {
	on(event: string, handler: unknown): void {
		if (event === "tool_call") {
			toolCallHandlers.push(handler as ExtensionHandler<ToolCallEvent, ToolCallEventResult>);
		}
		if (event === "before_agent_start") {
			beforeAgentStartHandlers.push(handler as ExtensionHandler<BeforeAgentStartEvent, BeforeAgentStartEventResult>);
		}
		if (event === "before_provider_request") {
			beforeProviderRequestHandlers.push(
				handler as ExtensionHandler<BeforeProviderRequestEvent, BeforeProviderRequestEventResult>,
			);
		}
		if (event === "tool_result") {
			toolResultHandlers.push(handler as ExtensionHandler<ToolResultEvent>);
		}
		if (event === "message_end") {
			messageEndHandlers.push(handler as TestMessageEndHandler);
		}
	},
	registerCommand(name: string, options: Omit<RegisteredCommand, "name" | "sourceInfo">): void {
		commandRegistrations.set(name, options);
	},
	appendEntry(customType: string, data?: unknown): void {
		customEntries.push({ customType, data });
	},
} as unknown as ExtensionAPI;

for (const factory of createClankyExtensionFactories(handlers)) await factory(fakeApi);
for (const expected of ["swarm", "cron", "mcp", "skill", "skills", "profile"]) {
	if (!commandRegistrations.has(expected)) throw new Error(`Missing registered command: ${expected}`);
}
const commandNotifications: string[] = [];
for (const name of ["swarm", "cron", "mcp", "skills", "profile"]) {
	await invokeCommand(commandRegistrations, name, commandNotifications);
}
await invokeCommand(commandRegistrations, "skill", commandNotifications, "add review-notes");
for (const expected of ["Swarm", "Cron", "MCP", "Skills", "Profile"]) {
	if (!commandNotifications.some((notification) => notification.includes(expected))) {
		throw new Error(`Command ${expected} did not notify a result: ${JSON.stringify(commandNotifications)}`);
	}
}
if (!commandNotifications.some((notification) => notification.includes("/skill:review-notes"))) {
	throw new Error(`Skill add command did not report the Pi invocation form: ${JSON.stringify(commandNotifications)}`);
}
const createSkillHandler = handlers.createSkill;
if (createSkillHandler === undefined) throw new Error("Expected createSkill handler in agent-tools smoke");
const createSkillOnlyCommands = new Map<string, Omit<RegisteredCommand, "name" | "sourceInfo">>();
const createSkillOnlyApi = {
	on(): void {},
	registerCommand(name: string, options: Omit<RegisteredCommand, "name" | "sourceInfo">): void {
		createSkillOnlyCommands.set(name, options);
	},
	appendEntry(): void {},
} as unknown as ExtensionAPI;
for (const factory of createClankyExtensionFactories({ createSkill: createSkillHandler })) {
	await factory(createSkillOnlyApi);
}
const createSkillOnlyNotifications: string[] = [];
await invokeCommand(createSkillOnlyCommands, "skill", createSkillOnlyNotifications, "add solo-skill");
if (!createSkillOnlyNotifications.some((notification) => notification.includes("/skill:solo-skill"))) {
	throw new Error(
		`Create-only skill command did not report the Pi invocation form: ${JSON.stringify(createSkillOnlyNotifications)}`,
	);
}
for (const expected of [
	"cron-command",
	"mcp-command",
	"skills-command",
	"skill-create:review-notes",
	"profile-command",
]) {
	if (!calls.includes(expected)) throw new Error(`Command handler was not invoked: ${expected}`);
}
const [toolCallHandler] = toolCallHandlers;
if (toolCallHandler === undefined) throw new Error("Expected tool_call hook to be registered");
const [beforeAgentStartHandler] = beforeAgentStartHandlers;
if (beforeAgentStartHandler === undefined) throw new Error("Expected before_agent_start hook to be registered");
const [beforeProviderRequestHandler] = beforeProviderRequestHandlers;
if (beforeProviderRequestHandler === undefined)
	throw new Error("Expected before_provider_request hook to be registered");
const [toolResultHandler] = toolResultHandlers;
if (toolResultHandler === undefined) throw new Error("Expected tool_result hook to be registered");
const [messageEndHandler] = messageEndHandlers;
if (messageEndHandler === undefined) throw new Error("Expected message_end hook to be registered");

const swarmSnapshot = await beforeAgentStartHandler(
	{
		type: "before_agent_start",
		prompt: "delegate this",
		systemPrompt: "",
		systemPromptOptions: {
			cwd: process.cwd(),
			skills: [
				{
					name: "swarm-leader",
					description: "",
					filePath: "",
					baseDir: "",
					sourceInfo: { path: "", source: "test", scope: "user", origin: "top-level" },
					disableModelInvocation: false,
				},
			],
		},
	},
	context(),
);
if (swarmSnapshot?.message?.customType !== "clanky.swarm_snapshot") {
	throw new Error(`Expected swarm snapshot custom message: ${JSON.stringify(swarmSnapshot)}`);
}

const providerPayload = { messages: [{ role: "user", content: "hello provider" }] };
const providerResult = await beforeProviderRequestHandler(
	{
		type: "before_provider_request",
		payload: providerPayload,
	},
	context(),
);
if (
	providerPayloads[0] !== providerPayload ||
	!isRecord(providerResult) ||
	providerResult.replaced !== true ||
	providerResult.original !== providerPayload
) {
	throw new Error(`Expected before_provider_request hook to replace the payload: ${JSON.stringify(providerResult)}`);
}
if (!calls.includes("provider:session-tool")) {
	throw new Error(`before_provider_request hook did not include the active session id: ${JSON.stringify(calls)}`);
}

await messageEndHandler(
	{
		type: "message_end",
		message: {
			role: "assistant",
			content: [{ type: "text", text: "Index this completed assistant message." }],
			timestamp: Date.parse("2026-01-01T00:00:00.000Z"),
		},
	},
	context(),
);
const [indexedMessage] = indexedMessages;
if (
	indexedMessage === undefined ||
	indexedMessage.sessionId !== "session-tool" ||
	indexedMessage.role !== "assistant" ||
	indexedMessage.text !== "Index this completed assistant message." ||
	indexedMessage.cwd !== process.cwd() ||
	indexedMessage.sessionFile !== "/tmp/clanky-agent-tools-session.jsonl" ||
	indexedMessage.messageKey !== "session-tool:leaf-message"
) {
	throw new Error(`Expected message_end hook to index the completed message: ${JSON.stringify(indexedMessages)}`);
}

const blocked = await toolCallHandler(
	{
		type: "tool_call",
		toolCallId: "write-1",
		toolName: "write",
		input: { path: "locked-file.ts", content: "x" },
	},
	context(),
);
if (blocked?.block !== true || blocked.reason !== "locked locked-file.ts") {
	throw new Error(`Expected write tool to be blocked by swarm file lock: ${JSON.stringify(blocked)}`);
}

const allowed = await toolCallHandler(
	{
		type: "tool_call",
		toolCallId: "edit-1",
		toolName: "edit",
		input: { path: "free-file.ts", edits: [{ oldText: "a", newText: "b" }] },
	},
	context(),
);
if (allowed !== undefined) {
	throw new Error(`Expected unlocked edit tool to continue: ${JSON.stringify(allowed)}`);
}
const hookCallsAfterEdit = calls.filter((call) => call.startsWith("hook:")).length;
const ignoredNonFileTool = await toolCallHandler(
	{
		type: "tool_call",
		toolCallId: "bash-1",
		toolName: "bash",
		input: { command: "printf locked-file.ts" },
	},
	context(),
);
if (ignoredNonFileTool !== undefined) {
	throw new Error(
		`Expected non-file mutation tool to bypass swarm file lock hook: ${JSON.stringify(ignoredNonFileTool)}`,
	);
}
const ignoredBlankPath = await toolCallHandler(
	{
		type: "tool_call",
		toolCallId: "write-blank",
		toolName: "write",
		input: { path: "   ", content: "x" },
	},
	context(),
);
if (ignoredBlankPath !== undefined) {
	throw new Error(`Expected blank write path to bypass swarm file lock hook: ${JSON.stringify(ignoredBlankPath)}`);
}
const hookCallsAfterIgnoredTools = calls.filter((call) => call.startsWith("hook:")).length;
if (hookCallsAfterIgnoredTools !== hookCallsAfterEdit) {
	throw new Error("Expected ignored tool calls not to invoke swarm file lock checks");
}

await toolResultHandler(
	{
		type: "tool_result",
		toolCallId: "dispatch-1",
		toolName: "swarm_dispatch",
		input: { title: "Dispatch", type: "implement", description: "Do it" },
		content: [{ type: "text", text: "ok" }],
		isError: false,
		details: { taskId: "task-tool" },
	},
	context(),
);
if (
	!customEntries.some((entry) => entry.customType === "clanky.swarm_task" && taskEntryId(entry.data) === "task-tool")
) {
	throw new Error(`Expected swarm task custom entry: ${JSON.stringify(customEntries)}`);
}
if (!calls.includes("mirror:swarm_dispatch:dispatch-1")) {
	throw new Error(`Expected tool_result hook to invoke the configured mirror handler: ${JSON.stringify(calls)}`);
}

const registryHomeDir = await mkdtemp(join(tmpdir(), "clanky-agent-tools-"));
const registry = new SessionRegistry({
	homeDir: registryHomeDir,
	watchSkills: false,
});
try {
	const storedTask = await registry.createTask({
		title: "Persisted local task",
		description: "Stored in index.db",
		sessionId: "session-tool",
		linearIssue: "PROJ-999",
	});
	await registry.createTask({
		title: "Completed local task",
		status: "done",
		priority: "high",
		sessionId: "session-tool",
		linearIssue: "PROJ-999",
	});
	if (storedTask.title !== "Persisted local task" || storedTask.sessionId !== "session-tool") {
		throw new Error(`SessionRegistry task ledger returned unexpected task: ${JSON.stringify(storedTask)}`);
	}
	const sessionTasks = await registry.listTasks({ sessionId: "session-tool" });
	if (!sessionTasks.some((candidate) => candidate.id === storedTask.id && candidate.linearIssue === "PROJ-999")) {
		throw new Error(`SessionRegistry task ledger did not list persisted task: ${JSON.stringify(sessionTasks)}`);
	}
	const doneTasks = await registry.listTasks({ linearIssue: "PROJ-999", status: "done", priority: "high" });
	if (doneTasks.length !== 1 || doneTasks[0]?.title !== "Completed local task" || doneTasks[0].priority !== "high") {
		throw new Error(`SessionRegistry task ledger did not filter completed task: ${JSON.stringify(doneTasks)}`);
	}
	const mismatchedPriorityTasks = await registry.listTasks({
		linearIssue: "PROJ-999",
		status: "done",
		priority: "low",
	});
	if (mismatchedPriorityTasks.length !== 0) {
		throw new Error(
			`SessionRegistry task ledger ignored the priority filter: ${JSON.stringify(mismatchedPriorityTasks)}`,
		);
	}
} finally {
	await registry.dispose();
	await rm(registryHomeDir, { force: true, recursive: true });
}

console.log(
	JSON.stringify({
		tools: tools.length,
		commands: commandRegistrations.size,
		calls: calls.length,
		indexedMessages: indexedMessages.length,
		blocked: blocked.block,
		entries: customEntries.length,
	}),
);

async function executeTool(tools: ToolDefinition[], name: string, params: Record<string, unknown>): Promise<unknown> {
	const tool = tools.find((candidate) => candidate.name === name);
	if (tool === undefined) throw new Error(`Missing tool: ${name}`);
	const result = await tool.execute(
		"tool-call",
		params as Parameters<typeof tool.execute>[1],
		undefined,
		undefined,
		context(),
	);
	if (result.content.length === 0) throw new Error(`Tool ${name} returned no content`);
	return result.details;
}

function context(): ExtensionContext {
	return {
		cwd: process.cwd(),
		sessionManager: {
			getSessionId: () => "session-tool",
			getSessionFile: () => "/tmp/clanky-agent-tools-session.jsonl",
			getLeafEntry: () => ({
				type: "message",
				id: "leaf-message",
				timestamp: "2026-01-01T00:00:00.000Z",
			}),
		},
	} as unknown as ExtensionContext;
}

async function invokeCommand(
	commands: Map<string, Omit<RegisteredCommand, "name" | "sourceInfo">>,
	name: string,
	notifications: string[],
	args = "",
): Promise<void> {
	const command = commands.get(name);
	if (command === undefined) throw new Error(`Missing registered command: ${name}`);
	await command.handler(args, commandContext(notifications));
}

function commandContext(notifications: string[]): ExtensionCommandContext {
	return {
		sessionManager: {
			getSessionId: () => "session-tool",
		},
		ui: {
			notify: (message: string) => {
				notifications.push(message);
			},
		},
		reload: async () => {
			notifications.push("reloaded");
		},
	} as unknown as ExtensionCommandContext;
}

function assertToolNames(tools: ToolDefinition[], expected: string[]): void {
	const names = new Set(tools.map((tool) => tool.name));
	for (const name of expected) {
		if (!names.has(name)) throw new Error(`Missing model-facing tool: ${name}`);
	}
}

function recordProperty(value: unknown, key: string): Record<string, unknown> {
	if (!isRecord(value)) throw new Error(`Expected object with ${key}: ${JSON.stringify(value)}`);
	const item = value[key];
	if (!isRecord(item)) throw new Error(`Expected ${key} object: ${JSON.stringify(value)}`);
	return item;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function taskEntryId(value: unknown): string | undefined {
	if (!isRecord(value)) return undefined;
	const taskId = value.taskId;
	return typeof taskId === "string" ? taskId : undefined;
}
