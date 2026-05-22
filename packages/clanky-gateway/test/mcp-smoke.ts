import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startGatewayServer } from "@clanky/gateway";
import { type Api, type AssistantMessage, createAssistantMessageEventStream, type Model } from "@earendil-works/pi-ai";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const homeDir = await mkdtemp(join(tmpdir(), "clanky-mcp-"));
const provider = "clanky-mcp-faux";
const model = "clanky-mcp-faux-model";
const responses = ["MCP faux session response.", "MCP faux follow-up response.", "MCP faux cron response."];
const fauxState = { callCount: 0 };
const previousLinearApiKey = process.env.LINEAR_API_KEY;
const previousLinearAccessToken = process.env.LINEAR_ACCESS_TOKEN;
const previousLinearEndpoint = process.env.LINEAR_GRAPHQL_ENDPOINT;
const previousExternalMcpServersJson = process.env.CLANKY_MCP_SERVERS_JSON;
delete process.env.LINEAR_ACCESS_TOKEN;
process.env.LINEAR_API_KEY = "linear-key";
process.env.CLANKY_MCP_SERVERS_JSON = JSON.stringify([
	{
		name: "faux",
		command: process.execPath,
		args: ["--import", "tsx", "packages/clanky-gateway/test/faux-external-mcp.ts"],
		cwd: process.cwd(),
		env: {
			CLANKY_FAUX_MCP_MARKER: "public-mcp-smoke",
		},
	},
]);
const linear = await startLinearServer("team-mcp");
process.env.LINEAR_GRAPHQL_ENDPOINT = linear.endpoint;
const server = await startGatewayServer({
	homeDir,
	configureModelRegistry: (modelRegistry) => {
		modelRegistry.registerProvider(provider, {
			api: "clanky-mcp-faux-api",
			baseUrl: "http://localhost:0",
			apiKey: "test-key",
			streamSimple: (streamModel) => createFauxStream(streamModel, nextFauxResponse()),
			models: [
				{
					id: model,
					name: "Clanky MCP Faux",
					reasoning: false,
					input: ["text"],
					cost: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
					},
					contextWindow: 128_000,
					maxTokens: 4_096,
				},
			],
		});
	},
});
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
const client = new Client({ name: "clanky-mcp-smoke", version: "0.0.0" });
const watchdog = setTimeout(() => {
	console.error("Timed out in mcp smoke");
	process.exit(1);
}, 15_000);

try {
	await client.connect(transport);
	const tools = await client.listTools();
	const toolNames = new Set(tools.tools.map((tool) => tool.name));
	const expectedToolNames = [
		"clanky.status",
		"cron.add",
		"cron.disable",
		"cron.enable",
		"cron.list",
		"cron.remove",
		"cron.run_now",
		"linear.create",
		"linear.flush",
		"linear.link",
		"linear.list",
		"linear.outbox",
		"mcp.call",
		"mcp.list",
		"memory.consent",
		"memory.export",
		"memory.forget",
		"memory.remember",
		"memory.search",
		"memory.status",
		"session.fork",
		"session.list",
		"session.search",
		"session.send",
		"skill.add",
		"skill.list",
		"skill.remove",
		"skill.usage",
		"task.add",
		"task.list",
		"task.update",
	];
	for (const name of expectedToolNames) {
		if (!toolNames.has(name)) {
			throw new Error(`Expected MCP tool ${name} to be registered`);
		}
	}
	for (const name of toolNames) {
		if (!expectedToolNames.includes(name)) {
			throw new Error(`Unexpected MCP tool registered: ${name}`);
		}
	}
	if (toolNames.size !== expectedToolNames.length) {
		throw new Error(
			`Expected ${expectedToolNames.length} MCP tools, got ${toolNames.size}: ${JSON.stringify([...toolNames])}`,
		);
	}

	const status = resultJson(await client.callTool({ name: "clanky.status", arguments: {} }));
	if (!isRecord(status) || status.running !== true || status.profile !== "default") {
		throw new Error("MCP clanky.status returned unexpected payload");
	}

	const memoryStatus = resultRecord(await client.callTool({ name: "memory.status", arguments: {} }));
	if (memoryStatus.atoms !== 0 || typeof memoryStatus.selfFile !== "string") {
		throw new Error(`MCP memory.status returned unexpected payload: ${JSON.stringify(memoryStatus)}`);
	}
	const memoryConsent = resultRecord(
		await client.callTool({
			name: "memory.consent",
			arguments: {
				scope: "channel",
				subject_id: "mcp-channel",
				enabled: true,
				mode: "channel",
			},
		}),
	);
	if (memoryConsent.enabled !== true || memoryConsent.scope !== "channel") {
		throw new Error(`MCP memory.consent returned unexpected payload: ${JSON.stringify(memoryConsent)}`);
	}
	const memoryRemember = resultRecord(
		await client.callTool({
			name: "memory.remember",
			arguments: {
				scope: "project",
				subject_id: process.cwd(),
				type: "decision",
				claim: "MCP memory smoke stores source-grounded decisions.",
				source_text: "MCP memory smoke stores source-grounded decisions.",
				confirmed: true,
				confidence: 0.87,
			},
		}),
	);
	const memoryAtom = recordProperty(memoryRemember, "atom");
	const memoryId = stringProperty(memoryAtom, "id");
	if (memoryRemember.saved !== true || memoryId === undefined) {
		throw new Error(`MCP memory.remember returned unexpected payload: ${JSON.stringify(memoryRemember)}`);
	}
	const memorySearch = resultRecord(
		await client.callTool({
			name: "memory.search",
			arguments: {
				q: "source-grounded decisions",
				scope: "project",
				subject_id: process.cwd(),
			},
		}),
	);
	if (!hasIdItem(arrayProperty(memorySearch, "atoms"), memoryId)) {
		throw new Error(`MCP memory.search did not include stored memory: ${JSON.stringify(memorySearch)}`);
	}
	const memoryExport = resultRecord(await client.callTool({ name: "memory.export", arguments: {} }));
	if (!hasIdItem(arrayProperty(memoryExport, "atoms"), memoryId)) {
		throw new Error(`MCP memory.export missed stored memory: ${JSON.stringify(memoryExport)}`);
	}
	const memoryForget = resultRecord(
		await client.callTool({
			name: "memory.forget",
			arguments: { id: memoryId },
		}),
	);
	if (memoryForget.forgotten !== 1) {
		throw new Error(`MCP memory.forget returned unexpected payload: ${JSON.stringify(memoryForget)}`);
	}

	const sessions = resultJson(await client.callTool({ name: "session.list", arguments: {} }));
	if (!isRecord(sessions) || !Array.isArray(sessions.sessions)) {
		throw new Error("MCP session.list returned unexpected payload");
	}

	const sessionSend = resultRecord(
		await client.callTool({
			name: "session.send",
			arguments: {
				prompt: "MCP session prompt",
				provider,
				model,
			},
		}),
	);
	const sessionId = stringProperty(sessionSend, "sessionId");
	if (sessionId === undefined || sessionSend.text !== responses[0]) {
		throw new Error(`MCP session.send returned unexpected payload: ${JSON.stringify(sessionSend)}`);
	}
	const sessionFollowup = resultRecord(
		await client.callTool({
			name: "session.send",
			arguments: {
				prompt: "MCP session follow-up",
				session_id: sessionId,
				provider,
				model,
			},
		}),
	);
	if (sessionFollowup.sessionId !== sessionId || sessionFollowup.text !== responses[1]) {
		throw new Error(`MCP session.send snake_case returned unexpected payload: ${JSON.stringify(sessionFollowup)}`);
	}
	const sessionFork = resultRecord(
		await client.callTool({
			name: "session.fork",
			arguments: { source_session_id: sessionId },
		}),
	);
	if (sessionFork.sourceSessionId !== sessionId || typeof sessionFork.sessionId !== "string") {
		throw new Error(`MCP session.fork returned unexpected payload: ${JSON.stringify(sessionFork)}`);
	}
	const sessionSearch = resultRecord(
		await client.callTool({
			name: "session.search",
			arguments: { q: "MCP session", limit: 5 },
		}),
	);
	if (!hasSessionSearchResult(arrayProperty(sessionSearch, "results"), sessionId)) {
		throw new Error(`MCP session.search did not find session.send text: ${JSON.stringify(sessionSearch)}`);
	}

	const skillName = "release-notes";
	const skillAdd = resultRecord(
		await client.callTool({
			name: "skill.add",
			arguments: {
				name: skillName,
				description: "Use for release note drafting.",
				body: "Draft concise release notes.",
			},
		}),
	);
	if (!hasNestedRecordValue(skillAdd, "skill", "name", skillName)) {
		throw new Error(`MCP skill.add returned unexpected payload: ${JSON.stringify(skillAdd)}`);
	}
	const skillList = resultRecord(await client.callTool({ name: "skill.list", arguments: {} }));
	if (!hasNamedItem(arrayProperty(skillList, "skills"), skillName)) {
		throw new Error(`MCP skill.list did not include created skill: ${JSON.stringify(skillList)}`);
	}
	const skillUsage = resultRecord(await client.callTool({ name: "skill.usage", arguments: {} }));
	if (!Array.isArray(skillUsage.usage)) {
		throw new Error(`MCP skill.usage returned unexpected payload: ${JSON.stringify(skillUsage)}`);
	}
	const skillRemove = resultRecord(
		await client.callTool({
			name: "skill.remove",
			arguments: { name: skillName },
		}),
	);
	if (skillRemove.removed !== true) {
		throw new Error(`MCP skill.remove returned unexpected payload: ${JSON.stringify(skillRemove)}`);
	}

	const taskAdd = resultRecord(
		await client.callTool({
			name: "task.add",
			arguments: {
				title: "MCP local task",
				description: "Created from MCP smoke.",
				status: "in_progress",
				priority: "high",
				session_id: sessionId,
				linear_issue: "PROJ-MCP-TASK",
			},
		}),
	);
	const task = recordProperty(taskAdd, "task");
	const taskId = stringProperty(task, "id");
	if (taskId === undefined || task.status !== "in_progress" || task.priority !== "high") {
		throw new Error(`MCP task.add returned unexpected payload: ${JSON.stringify(taskAdd)}`);
	}
	const taskList = resultRecord(
		await client.callTool({
			name: "task.list",
			arguments: {
				status: "in_progress",
				priority: "high",
				linear_issue: "PROJ-MCP-TASK",
				limit: 5,
			},
		}),
	);
	if (!hasIdItem(arrayProperty(taskList, "tasks"), taskId)) {
		throw new Error(`MCP task.list did not include created task: ${JSON.stringify(taskList)}`);
	}
	const taskUpdate = resultRecord(
		await client.callTool({
			name: "task.update",
			arguments: {
				id: taskId,
				title: "MCP completed local task",
				status: "done",
				priority: "normal",
			},
		}),
	);
	if (
		!hasNestedRecordValue(taskUpdate, "task", "status", "done") ||
		!hasNestedRecordValue(taskUpdate, "task", "priority", "normal")
	) {
		throw new Error(`MCP task.update returned unexpected payload: ${JSON.stringify(taskUpdate)}`);
	}
	const taskDoneList = resultRecord(
		await client.callTool({
			name: "task.list",
			arguments: {
				status: "done",
				priority: "normal",
				linear_issue: "PROJ-MCP-TASK",
				limit: 5,
			},
		}),
	);
	if (!hasIdItem(arrayProperty(taskDoneList, "tasks"), taskId)) {
		throw new Error(`MCP task.list did not include updated task: ${JSON.stringify(taskDoneList)}`);
	}
	const externalMcpList = resultRecord(await client.callTool({ name: "mcp.list", arguments: {} }));
	const externalMcpServers = arrayProperty(externalMcpList, "servers");
	const externalMcpFaux = externalMcpServers.find((candidate) => isRecord(candidate) && candidate.name === "faux");
	if (
		!isRecord(externalMcpFaux) ||
		externalMcpFaux.state !== "booted" ||
		!hasNamedItem(arrayProperty(externalMcpFaux, "tools"), "echo")
	) {
		throw new Error(`MCP mcp.list returned unexpected payload: ${JSON.stringify(externalMcpList)}`);
	}
	const externalMcpCall = resultRecord(
		await client.callTool({
			name: "mcp.call",
			arguments: {
				server: "faux",
				tool: "echo",
				arguments: { message: "hello public mcp" },
			},
		}),
	);
	const externalMcpCallResult = recordProperty(externalMcpCall, "result");
	if (
		externalMcpCall.server !== "faux" ||
		externalMcpCall.tool !== "echo" ||
		externalMcpCallResult.message !== "hello public mcp" ||
		externalMcpCallResult.marker !== "public-mcp-smoke"
	) {
		throw new Error(`MCP mcp.call returned unexpected payload: ${JSON.stringify(externalMcpCall)}`);
	}

	const cronAdd = resultRecord(
		await client.callTool({
			name: "cron.add",
			arguments: {
				schedule: "2026-01-01T00:00:01.000Z",
				prompt: "MCP cron prompt",
				deliver: "stdout",
				provider,
				model,
				timeout_seconds: 11,
				idempotency_key: "mcp-cron-smoke-1",
			},
		}),
	);
	const cronJob = recordProperty(cronAdd, "job");
	const cronJobId = stringProperty(cronJob, "id");
	if (
		cronJobId === undefined ||
		cronJob.prompt !== "MCP cron prompt" ||
		cronJob.timeoutSeconds !== 11 ||
		cronJob.idempotencyKey !== "mcp-cron-smoke-1"
	) {
		throw new Error(`MCP cron.add returned unexpected payload: ${JSON.stringify(cronAdd)}`);
	}
	const cronList = resultRecord(await client.callTool({ name: "cron.list", arguments: {} }));
	if (!hasIdItem(arrayProperty(cronList, "jobs"), cronJobId)) {
		throw new Error(`MCP cron.list did not include created job: ${JSON.stringify(cronList)}`);
	}
	const cronDisable = resultRecord(
		await client.callTool({
			name: "cron.disable",
			arguments: { job_id: cronJobId },
		}),
	);
	if (!hasNestedRecordValue(cronDisable, "job", "enabled", false)) {
		throw new Error(`MCP cron.disable returned unexpected payload: ${JSON.stringify(cronDisable)}`);
	}
	const cronEnable = resultRecord(
		await client.callTool({
			name: "cron.enable",
			arguments: { job_id: cronJobId },
		}),
	);
	if (!hasNestedRecordValue(cronEnable, "job", "enabled", true)) {
		throw new Error(`MCP cron.enable returned unexpected payload: ${JSON.stringify(cronEnable)}`);
	}
	const cronRunNow = resultRecord(
		await client.callTool({
			name: "cron.run_now",
			arguments: { job_id: cronJobId },
		}),
	);
	const cronRun = recordProperty(cronRunNow, "result");
	if (cronRun.ok !== true || cronRun.text !== responses[2] || cronRun.deliveredTo !== "stdout") {
		throw new Error(`MCP cron.run_now returned unexpected payload: ${JSON.stringify(cronRunNow)}`);
	}
	const cronRunOutputFile = stringProperty(cronRun, "outputFile");
	if (cronRunOutputFile === undefined || (await readFile(cronRunOutputFile, "utf8")) !== responses[2]) {
		throw new Error(`MCP cron.run_now stdout delivery did not persist output: ${JSON.stringify(cronRunNow)}`);
	}
	const cronRemove = resultRecord(
		await client.callTool({
			name: "cron.remove",
			arguments: { job_id: cronJobId },
		}),
	);
	if (cronRemove.removed !== true) {
		throw new Error(`MCP cron.remove returned unexpected payload: ${JSON.stringify(cronRemove)}`);
	}

	const linearLink = resultRecord(
		await client.callTool({
			name: "linear.link",
			arguments: {
				issue_id: "PROJ-321",
				task_id: "task-mcp",
				note: "linked from MCP smoke",
			},
		}),
	);
	if (!hasNestedRecordValue(linearLink, "link", "issueId", "PROJ-321")) {
		throw new Error(`MCP linear.link returned unexpected payload: ${JSON.stringify(linearLink)}`);
	}
	const linearList = resultRecord(await client.callTool({ name: "linear.list", arguments: {} }));
	if (!hasLinearLink(arrayProperty(linearList, "links"), "PROJ-321", "task-mcp")) {
		throw new Error(`MCP linear.list did not include created link: ${JSON.stringify(linearList)}`);
	}
	const linearCreate = resultRecord(
		await client.callTool({
			name: "linear.create",
			arguments: {
				team_id: "team-mcp",
				title: "Created through MCP smoke",
				description: "Exercise MCP linear.create through the daemon socket.",
			},
		}),
	);
	if (!hasNestedRecordValue(linearCreate, "issue", "identifier", "MCP-100") || linear.requests.length !== 1) {
		throw new Error(`MCP linear.create returned unexpected payload: ${JSON.stringify(linearCreate)}`);
	}
	const linearOutbox = resultRecord(await client.callTool({ name: "linear.outbox", arguments: {} }));
	if (!Array.isArray(linearOutbox.entries)) {
		throw new Error(`MCP linear.outbox returned unexpected payload: ${JSON.stringify(linearOutbox)}`);
	}
	const pendingLinear = await server.registry.addLinearOutboxEntry({
		issueId: "PROJ-MCP-OUTBOX",
		body: "MCP pending comment",
	});
	const linearFlush = resultRecord(await client.callTool({ name: "linear.flush", arguments: { limit: 1 } }));
	const postedLinearEntries = arrayProperty(linearFlush, "posted");
	if (
		!postedLinearEntries.some(
			(entry) => isRecord(entry) && entry.id === pendingLinear.id && entry.status === "posted",
		) ||
		arrayProperty(linearFlush, "failed").length !== 0
	) {
		throw new Error(`MCP linear.flush did not post the pending entry: ${JSON.stringify(linearFlush)}`);
	}
	if (Number(linear.requests.length) !== 2) {
		throw new Error(`MCP Linear tools made unexpected request count: ${JSON.stringify(linear.requests)}`);
	}

	console.log(
		JSON.stringify({
			tools: tools.tools.length,
			status: status.running,
			sessions: arrayProperty(resultRecord(await client.callTool({ name: "session.list", arguments: {} })), "sessions")
				.length,
			cronJobId,
			linearLinks: arrayProperty(linearList, "links").length,
			linearCreated: property(recordProperty(linearCreate, "issue"), "identifier"),
			externalMcpServers: externalMcpServers.length,
			modelCalls: fauxState.callCount,
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
	await linear.close();
	restoreEnv("LINEAR_API_KEY", previousLinearApiKey);
	restoreEnv("LINEAR_ACCESS_TOKEN", previousLinearAccessToken);
	restoreEnv("LINEAR_GRAPHQL_ENDPOINT", previousLinearEndpoint);
	restoreEnv("CLANKY_MCP_SERVERS_JSON", previousExternalMcpServersJson);
	await rm(homeDir, { force: true, recursive: true });
}

await assertStartMcpCommand();

function tsxBinary(): string {
	const name = process.platform === "win32" ? "tsx.cmd" : "tsx";
	return join(process.cwd(), "node_modules", ".bin", name);
}

async function assertStartMcpCommand(): Promise<void> {
	const startHomeDir = await mkdtemp(join(tmpdir(), "clanky-start-mcp-"));
	const startTransport = new StdioClientTransport({
		command: tsxBinary(),
		args: ["packages/clanky-cli/src/bin.ts", "start", "--home", startHomeDir, "--mcp"],
		cwd: process.cwd(),
		env: getDefaultEnvironment(),
		stderr: "pipe",
	});
	const startStderrChunks: string[] = [];
	startTransport.stderr?.on("data", (chunk) => {
		startStderrChunks.push(String(chunk));
	});
	const startClient = new Client({ name: "clanky-start-mcp-smoke", version: "0.0.0" });
	const startWatchdog = setTimeout(() => {
		console.error("Timed out in start --mcp smoke");
		process.exit(1);
	}, 15_000);
	try {
		await startClient.connect(startTransport);
		const tools = await startClient.listTools();
		if (!tools.tools.some((tool) => tool.name === "clanky.status")) {
			throw new Error("Expected clanky.status from start --mcp");
		}
		const status = resultRecord(await startClient.callTool({ name: "clanky.status", arguments: {} }));
		if (status.running !== true || status.profile !== "default") {
			throw new Error(`start --mcp clanky.status returned unexpected payload: ${JSON.stringify(status)}`);
		}
		console.log(JSON.stringify({ startMcp: true, startMcpTools: tools.tools.length }));
	} catch (error) {
		const stderr = startStderrChunks.join("").trim();
		if (stderr.length > 0) console.error(stderr);
		throw error;
	} finally {
		clearTimeout(startWatchdog);
		await startClient.close();
		await rm(startHomeDir, { force: true, recursive: true });
	}
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

function resultRecord(value: unknown): Record<string, unknown> {
	const parsed = resultJson(value);
	if (!isRecord(parsed)) throw new Error(`Expected object result: ${JSON.stringify(value)}`);
	return parsed;
}

function arrayProperty(value: Record<string, unknown>, key: string): unknown[] {
	const item = value[key];
	if (!Array.isArray(item)) throw new Error(`Expected ${key} array: ${JSON.stringify(value)}`);
	return item;
}

function property(value: unknown, key: string): unknown {
	if (!isRecord(value)) return undefined;
	return value[key];
}

function recordProperty(value: Record<string, unknown>, key: string): Record<string, unknown> {
	const item = value[key];
	if (!isRecord(item)) throw new Error(`Expected ${key} object: ${JSON.stringify(value)}`);
	return item;
}

function stringProperty(value: Record<string, unknown>, key: string): string | undefined {
	const item = value[key];
	return typeof item === "string" && item.length > 0 ? item : undefined;
}

function hasNestedRecordValue(
	parent: Record<string, unknown>,
	key: string,
	childKey: string,
	expected: unknown,
): boolean {
	const child = parent[key];
	return isRecord(child) && child[childKey] === expected;
}

function hasNamedItem(items: unknown[], name: string): boolean {
	return items.some((item) => isRecord(item) && item.name === name);
}

function hasIdItem(items: unknown[], id: string): boolean {
	return items.some((item) => isRecord(item) && item.id === id);
}

function hasLinearLink(items: unknown[], issueId: string, taskId: string): boolean {
	return items.some((item) => isRecord(item) && item.issueId === issueId && item.taskId === taskId);
}

function hasSessionSearchResult(items: unknown[], sessionId: string): boolean {
	return items.some((item) => isRecord(item) && item.sessionId === sessionId);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nextFauxResponse(): string {
	const response = responses[fauxState.callCount] ?? responses.at(-1);
	fauxState.callCount += 1;
	if (response === undefined) throw new Error("No faux MCP response configured");
	return response;
}

function createFauxStream(streamModel: Model<Api>, text: string) {
	const message = createAssistantMessage(streamModel, text);
	const stream = createAssistantMessageEventStream();
	queueMicrotask(() => {
		stream.push({ type: "start", partial: message });
		stream.push({ type: "text_start", contentIndex: 0, partial: message });
		stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: message });
		stream.push({ type: "text_end", contentIndex: 0, content: text, partial: message });
		stream.push({ type: "done", reason: "stop", message });
	});
	return stream;
}

function createAssistantMessage(streamModel: Model<Api>, text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: streamModel.api,
		provider: streamModel.provider,
		model: streamModel.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				total: 0,
			},
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

interface LinearRequest {
	authorization: string | null;
	body: string;
}

interface LinearServer {
	endpoint: string;
	requests: LinearRequest[];
	close(): Promise<void>;
}

async function startLinearServer(expectedTeamId: string): Promise<LinearServer> {
	const requests: LinearRequest[] = [];
	const server = createServer(async (request, response) => {
		let body = "";
		for await (const chunk of request) body += chunk.toString("utf8");
		requests.push({ authorization: request.headers.authorization ?? null, body });
		const input = requestInput(body);
		const query = requestQuery(body);
		if (query.includes("commentCreate")) {
			response.writeHead(200, { "content-type": "application/json" });
			if (input.issueId !== "PROJ-MCP-OUTBOX" || input.body !== "MCP pending comment") {
				response.end(JSON.stringify({ errors: [{ message: `unexpected input ${JSON.stringify(input)}` }] }));
				return;
			}
			response.end(
				JSON.stringify({
					data: {
						commentCreate: {
							success: true,
							comment: {
								id: "comment-mcp",
								url: "https://linear.example/comment-mcp",
								issue: {
									id: input.issueId,
									identifier: input.issueId,
								},
							},
						},
					},
				}),
			);
			return;
		}
		if (
			!query.includes("issueCreate") ||
			input.teamId !== expectedTeamId ||
			input.title !== "Created through MCP smoke"
		) {
			response.writeHead(200, { "content-type": "application/json" });
			response.end(JSON.stringify({ errors: [{ message: `unexpected input ${JSON.stringify(input)}` }] }));
			return;
		}
		response.writeHead(200, { "content-type": "application/json" });
		response.end(
			JSON.stringify({
				data: {
					issueCreate: {
						success: true,
						issue: {
							id: "issue-mcp",
							identifier: "MCP-100",
							title: input.title,
							url: "https://linear.example/MCP-100",
							team: {
								id: input.teamId,
							},
						},
					},
				},
			}),
		);
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => resolve());
	});
	const address = server.address();
	if (typeof address !== "object" || address === null) throw new Error("Could not bind Linear MCP smoke server");
	return {
		endpoint: `http://127.0.0.1:${address.port}/graphql`,
		requests,
		close: async () => {
			await new Promise<void>((resolve, reject) => {
				server.close((error) => {
					if (error) {
						reject(error);
					} else {
						resolve();
					}
				});
			});
		},
	};
}

function requestInput(body: string): Record<string, unknown> {
	const parsed = JSON.parse(body) as unknown;
	const variables = property(parsed, "variables");
	const input = property(variables, "input");
	if (!isRecord(input)) throw new Error(`Linear request did not include input: ${body}`);
	return input;
}

function requestQuery(body: string): string {
	const parsed = JSON.parse(body) as unknown;
	const query = property(parsed, "query");
	if (typeof query !== "string") throw new Error(`Linear request did not include query: ${body}`);
	return query;
}

function restoreEnv(key: string, value: string | undefined): void {
	if (value === undefined) {
		delete process.env[key];
	} else {
		process.env[key] = value;
	}
}
