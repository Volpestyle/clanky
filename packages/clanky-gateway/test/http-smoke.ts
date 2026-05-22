import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startGatewayServer } from "@clanky/gateway";
import { type Api, type AssistantMessage, createAssistantMessageEventStream, type Model } from "@earendil-works/pi-ai";

const provider = "clanky-http-faux";
const model = "clanky-http-faux-session";
const api = "clanky-http-faux-api";
const expected = "HTTP faux response from Clanky.";
const homeDir = await mkdtemp(join(tmpdir(), "clanky-http-"));
const port = await freePort();
const fauxState = { callCount: 0 };
const previousLinearApiKey = process.env.LINEAR_API_KEY;
const previousLinearAccessToken = process.env.LINEAR_ACCESS_TOKEN;
const previousLinearEndpoint = process.env.LINEAR_GRAPHQL_ENDPOINT;
let linear: LinearServer | undefined;
const server = await startGatewayServer({
	homeDir,
	http: { hostname: "127.0.0.1", port },
	configureModelRegistry: (modelRegistry) => {
		modelRegistry.registerProvider(provider, {
			api,
			baseUrl: "http://localhost:0",
			apiKey: "test-key",
			streamSimple: (streamModel) => createFauxStream(streamModel, expected, fauxState),
			models: [
				{
					id: model,
					name: "Clanky HTTP Faux Session",
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

try {
	const baseUrl = `http://127.0.0.1:${port}`;
	const unauthorized = await fetch(`${baseUrl}/status`);
	if (unauthorized.status !== 401) {
		throw new Error(`Expected unauthorized /status to return 401, got ${unauthorized.status}`);
	}

	const token = (await readFile(server.registry.paths.httpTokenFile, "utf8")).trim();
	if (token.length === 0) throw new Error("HTTP token file was empty");

	const status = await fetchJson(`${baseUrl}/status`, token);
	if (
		!isRecord(status) ||
		status.running !== true ||
		status.profile !== "default" ||
		status.swarmPeers !== 0 ||
		status.swarmTasks !== 0
	) {
		throw new Error("HTTP /status returned unexpected payload");
	}

	const memoryStatus = await fetchRecord(`${baseUrl}/memory/status`, token);
	if (memoryStatus.atoms !== 0 || typeof memoryStatus.selfFile !== "string") {
		throw new Error(`HTTP /memory/status returned unexpected payload: ${JSON.stringify(memoryStatus)}`);
	}
	const memoryConsent = await fetchRecord(`${baseUrl}/memory/consent`, token, {
		method: "PUT",
		body: {
			scope: "channel",
			subjectId: "http-channel",
			enabled: true,
			mode: "channel",
		},
	});
	if (memoryConsent.enabled !== true || memoryConsent.scope !== "channel") {
		throw new Error(`HTTP /memory/consent returned unexpected payload: ${JSON.stringify(memoryConsent)}`);
	}
	const memoryRemember = await fetchRecord(`${baseUrl}/memory`, token, {
		method: "POST",
		body: {
			scope: "project",
			subjectId: process.cwd(),
			type: "decision",
			claim: "HTTP memory smoke stores source-grounded decisions.",
			sourceText: "HTTP memory smoke stores source-grounded decisions.",
			confirmed: true,
			confidence: 0.88,
		},
	});
	if (memoryRemember.saved !== true || !isRecord(memoryRemember.atom)) {
		throw new Error(`HTTP /memory remember returned unexpected payload: ${JSON.stringify(memoryRemember)}`);
	}
	const memoryId = stringProperty(memoryRemember.atom, "id");
	if (memoryId === undefined) throw new Error(`HTTP memory id was missing: ${JSON.stringify(memoryRemember)}`);
	const memorySearch = await fetchRecord(
		`${baseUrl}/memory?q=${encodeURIComponent("source-grounded decisions")}&scope=project&subjectId=${encodeURIComponent(process.cwd())}`,
		token,
	);
	if (!hasIdItem(arrayProperty(memorySearch, "atoms"), memoryId)) {
		throw new Error(`HTTP /memory search did not include stored memory: ${JSON.stringify(memorySearch)}`);
	}
	const memoryExport = await fetchRecord(`${baseUrl}/memory/export`, token);
	if (
		!hasIdItem(arrayProperty(memoryExport, "atoms"), memoryId) ||
		arrayProperty(memoryExport, "events").length === 0
	) {
		throw new Error(`HTTP /memory/export missed stored memory: ${JSON.stringify(memoryExport)}`);
	}
	const memoryForget = await fetchRecord(`${baseUrl}/memory/${memoryId}`, token, { method: "DELETE" });
	if (memoryForget.forgotten !== 1) {
		throw new Error(`HTTP /memory/:id did not forget one memory: ${JSON.stringify(memoryForget)}`);
	}
	await server.messaging.broker.handleIncoming({
		platform: "telegram",
		platformMessageId: "memory-msg-1",
		chatId: "memory-chat",
		chatType: "dm",
		userId: "memory-user",
		timestamp: Date.now(),
		text: "Gateway messaging should record source events for allowed DM messages.",
		type: "text",
		attachments: [],
		mentionsBot: true,
	});
	const messagingMemoryExport = await server.registry.exportMemory();
	if (
		!messagingMemoryExport.events.some(
			(event) =>
				event.source === "telegram" &&
				event.sourceId === "memory-msg-1" &&
				event.scope === "user" &&
				event.subjectId === "telegram:user:memory-user",
		)
	) {
		throw new Error(
			`Gateway messaging memory bridge did not record the inbound event: ${JSON.stringify(messagingMemoryExport)}`,
		);
	}

	const initialSessions = await fetchJson(`${baseUrl}/sessions`, token);
	if (!isRecord(initialSessions) || !Array.isArray(initialSessions.sessions)) {
		throw new Error("HTTP /sessions returned unexpected payload");
	}

	const send = await fetchJson(`${baseUrl}/sessions/new/messages`, token, {
		method: "POST",
		body: {
			prompt: "HTTP smoke prompt",
			provider,
			model,
		},
	});
	if (!isRecord(send) || typeof send.sessionId !== "string" || send.text !== expected) {
		throw new Error(`HTTP session message returned unexpected payload: ${JSON.stringify(send)}`);
	}
	const sessionId = send.sessionId;
	const followup = await fetchJson(`${baseUrl}/sessions/${sessionId}/messages`, token, {
		method: "POST",
		body: {
			prompt: "HTTP smoke follow-up prompt",
			provider,
			model,
		},
	});
	if (!isRecord(followup) || followup.sessionId !== sessionId || followup.text !== expected) {
		throw new Error(`HTTP /sessions/:id/messages returned unexpected payload: ${JSON.stringify(followup)}`);
	}

	const sessions = await fetchJson(`${baseUrl}/sessions`, token);
	if (!isRecord(sessions) || !Array.isArray(sessions.sessions) || !hasSession(sessions.sessions, sessionId)) {
		throw new Error("HTTP /sessions did not include the created session");
	}

	const search = await fetchJson(`${baseUrl}/sessions/search?q=HTTP%20smoke`, token);
	if (!isRecord(search) || !Array.isArray(search.results) || !hasSearchResult(search.results, sessionId)) {
		throw new Error(`HTTP /sessions/search did not find the created session: ${JSON.stringify(search)}`);
	}
	const fork = await fetchRecord(`${baseUrl}/sessions/${sessionId}/fork`, token, { method: "POST", body: {} });
	if (fork.sourceSessionId !== sessionId || typeof fork.sessionId !== "string" || fork.sessionId === sessionId) {
		throw new Error(`HTTP session fork returned unexpected payload: ${JSON.stringify(fork)}`);
	}

	const skillName = "http-release-notes";
	const skillAdd = await fetchRecord(`${baseUrl}/skills`, token, {
		method: "POST",
		body: {
			name: skillName,
			description: "Use for HTTP smoke release notes.",
			body: "Draft concise release notes from HTTP smoke evidence.",
		},
	});
	if (!hasNestedRecordValue(skillAdd, "skill", "name", skillName)) {
		throw new Error(`HTTP /skills add returned unexpected payload: ${JSON.stringify(skillAdd)}`);
	}
	const skills = await fetchRecord(`${baseUrl}/skills`, token);
	if (!hasNamedItem(arrayProperty(skills, "skills"), skillName)) {
		throw new Error(`HTTP /skills did not include the created skill: ${JSON.stringify(skills)}`);
	}
	const skillUsage = await fetchRecord(`${baseUrl}/skills/usage`, token);
	arrayProperty(skillUsage, "usage");
	const skillRemove = await fetchRecord(`${baseUrl}/skills/${encodeURIComponent(skillName)}`, token, {
		method: "DELETE",
	});
	if (skillRemove.removed !== true) {
		throw new Error(`HTTP skill delete returned unexpected payload: ${JSON.stringify(skillRemove)}`);
	}

	const taskAdd = await fetchRecord(`${baseUrl}/tasks`, token, {
		method: "POST",
		body: {
			title: "HTTP local task",
			description: "Created from HTTP smoke.",
			status: "in_progress",
			priority: "high",
			sessionId,
			linearIssue: "PROJ-HTTP-TASK",
		},
	});
	const task = nestedRecord(taskAdd, "task");
	const taskId = stringProperty(task, "id");
	if (taskId === undefined || task.status !== "in_progress" || task.priority !== "high" || task.source !== "http") {
		throw new Error(`HTTP /tasks add returned unexpected payload: ${JSON.stringify(taskAdd)}`);
	}
	const tasks = await fetchRecord(
		`${baseUrl}/tasks?status=in_progress&priority=high&linearIssue=PROJ-HTTP-TASK&limit=5`,
		token,
	);
	if (!arrayProperty(tasks, "tasks").some((item) => isRecord(item) && item.id === taskId)) {
		throw new Error(`HTTP /tasks did not include the created task: ${JSON.stringify(tasks)}`);
	}
	const taskUpdate = await fetchRecord(`${baseUrl}/tasks/${taskId}`, token, {
		method: "PATCH",
		body: {
			title: "HTTP completed local task",
			status: "done",
			priority: "normal",
		},
	});
	if (
		!hasNestedRecordValue(taskUpdate, "task", "status", "done") ||
		!hasNestedRecordValue(taskUpdate, "task", "priority", "normal")
	) {
		throw new Error(`HTTP /tasks update returned unexpected payload: ${JSON.stringify(taskUpdate)}`);
	}
	const updatedTasks = await fetchRecord(
		`${baseUrl}/tasks?status=done&priority=normal&linearIssue=PROJ-HTTP-TASK&limit=5`,
		token,
	);
	if (!arrayProperty(updatedTasks, "tasks").some((item) => isRecord(item) && item.id === taskId)) {
		throw new Error(`HTTP /tasks did not include the updated task: ${JSON.stringify(updatedTasks)}`);
	}

	const linearLink = await fetchRecord(`${baseUrl}/linear/links`, token, {
		method: "POST",
		body: {
			issueId: "PROJ-HTTP",
			sessionId,
			note: "linked from HTTP smoke",
		},
	});
	if (!hasNestedRecordValue(linearLink, "link", "issueId", "PROJ-HTTP")) {
		throw new Error(`HTTP /linear/links add returned unexpected payload: ${JSON.stringify(linearLink)}`);
	}
	const linearLinks = await fetchRecord(`${baseUrl}/linear/links`, token);
	if (!arrayProperty(linearLinks, "links").some((link) => isRecord(link) && link.sessionId === sessionId)) {
		throw new Error(`HTTP /linear/links did not include the created link: ${JSON.stringify(linearLinks)}`);
	}
	const linearOutbox = await fetchRecord(`${baseUrl}/linear/outbox`, token);
	arrayProperty(linearOutbox, "entries");
	linear = await startLinearServer();
	process.env.LINEAR_API_KEY = "linear-http-key";
	delete process.env.LINEAR_ACCESS_TOKEN;
	process.env.LINEAR_GRAPHQL_ENDPOINT = linear.endpoint;
	const linearCreate = await fetchRecord(`${baseUrl}/linear/issues`, token, {
		method: "POST",
		body: {
			team_id: "team-http",
			title: "Created through HTTP smoke",
			description: "Exercise HTTP linear issue creation.",
			priority: 1,
		},
	});
	if (
		!hasNestedRecordValue(linearCreate, "issue", "identifier", "HTTP-100") ||
		!hasNestedRecordValue(linearCreate, "issue", "teamId", "team-http")
	) {
		throw new Error(`HTTP /linear/issues returned unexpected payload: ${JSON.stringify(linearCreate)}`);
	}
	const outboxEntry = await server.registry.addLinearOutboxEntry({
		issueId: "PROJ-HTTP-OUTBOX",
		body: "HTTP pending comment",
	});
	const linearFlush = await fetchRecord(`${baseUrl}/linear/outbox/flush`, token, {
		method: "POST",
		body: { limit: 1 },
	});
	const flushedPosted = arrayProperty(linearFlush, "posted");
	if (
		!flushedPosted.some((entry) => isRecord(entry) && entry.id === outboxEntry.id && entry.status === "posted") ||
		arrayProperty(linearFlush, "failed").length !== 0
	) {
		throw new Error(`HTTP /linear/outbox/flush did not post the pending entry: ${JSON.stringify(linearFlush)}`);
	}
	if (linear.requests.length !== 2) {
		throw new Error(`HTTP Linear routes made unexpected request count: ${JSON.stringify(linear.requests)}`);
	}

	const cronAdd = await fetchRecord(`${baseUrl}/cron/jobs`, token, {
		method: "POST",
		body: {
			schedule: "2026-01-01T00:00:01.000Z",
			prompt: "HTTP cron prompt",
			deliver: "file",
			provider,
			model,
			timeout_seconds: 9,
			idempotency_key: "http-cron-smoke-1",
		},
	});
	const cronJob = nestedRecord(cronAdd, "job");
	const cronJobId = stringProperty(cronJob, "id");
	if (cronJobId === undefined || cronJob.timeoutSeconds !== 9 || cronJob.idempotencyKey !== "http-cron-smoke-1") {
		throw new Error(`HTTP /cron/jobs add returned unexpected payload: ${JSON.stringify(cronAdd)}`);
	}
	const cronList = await fetchRecord(`${baseUrl}/cron/jobs`, token);
	if (!hasCronJob(arrayProperty(cronList, "jobs"), cronJobId)) {
		throw new Error(`HTTP /cron/jobs did not include the created job: ${JSON.stringify(cronList)}`);
	}
	const cronDisable = await fetchRecord(`${baseUrl}/cron/jobs/${cronJobId}/disable`, token, { method: "POST" });
	if (nestedRecord(cronDisable, "job").enabled !== false) {
		throw new Error(`HTTP cron disable returned unexpected payload: ${JSON.stringify(cronDisable)}`);
	}
	const cronEnable = await fetchRecord(`${baseUrl}/cron/jobs/${cronJobId}/enable`, token, { method: "POST" });
	if (nestedRecord(cronEnable, "job").enabled !== true) {
		throw new Error(`HTTP cron enable returned unexpected payload: ${JSON.stringify(cronEnable)}`);
	}
	const cronRun = await fetchRecord(`${baseUrl}/cron/jobs/${cronJobId}/run`, token, { method: "POST" });
	const cronRunResult = nestedRecord(cronRun, "result");
	if (
		cronRunResult.ok !== true ||
		cronRunResult.text !== expected ||
		typeof cronRunResult.outputFile !== "string" ||
		cronRunResult.deliveredTo !== cronRunResult.outputFile
	) {
		throw new Error(`HTTP cron run returned unexpected payload: ${JSON.stringify(cronRun)}`);
	}
	if ((await readFile(cronRunResult.outputFile, "utf8")) !== expected) {
		throw new Error("HTTP cron file delivery did not write the model response to the output file");
	}
	const cronRemove = await fetchRecord(`${baseUrl}/cron/jobs/${cronJobId}`, token, { method: "DELETE" });
	if (cronRemove.removed !== true) {
		throw new Error(`HTTP cron delete returned unexpected payload: ${JSON.stringify(cronRemove)}`);
	}

	console.log(
		JSON.stringify({
			port,
			status: status.running,
			sessions: sessions.sessions.length,
			callCount: fauxState.callCount,
			cronJobId,
			linearLinks: arrayProperty(linearLinks, "links").length,
			linearRequests: linear.requests.length,
		}),
	);
} finally {
	await linear?.close();
	restoreEnv("LINEAR_API_KEY", previousLinearApiKey);
	restoreEnv("LINEAR_ACCESS_TOKEN", previousLinearAccessToken);
	restoreEnv("LINEAR_GRAPHQL_ENDPOINT", previousLinearEndpoint);
	await server.close();
	await rm(homeDir, { force: true, recursive: true });
}

interface FetchJsonOptions {
	method?: string;
	body?: unknown;
}

async function fetchJson(url: string, token: string, options: FetchJsonOptions = {}): Promise<unknown> {
	const headers = new Headers({
		Authorization: `Bearer ${token}`,
	});
	if (options.body !== undefined) headers.set("content-type", "application/json");
	const request: RequestInit = { headers };
	if (options.method !== undefined) request.method = options.method;
	if (options.body !== undefined) request.body = JSON.stringify(options.body);
	const response = await fetch(url, request);
	if (!response.ok) throw new Error(`${url} returned ${response.status}`);
	return (await response.json()) as unknown;
}

async function fetchRecord(
	url: string,
	token: string,
	options: FetchJsonOptions = {},
): Promise<Record<string, unknown>> {
	const value = await fetchJson(url, token, options);
	if (!isRecord(value)) throw new Error(`Expected object from ${url}: ${JSON.stringify(value)}`);
	return value;
}

function createFauxStream(streamModel: Model<Api>, text: string, state: { callCount: number }) {
	state.callCount++;
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

async function freePort(): Promise<number> {
	const server = createNetServer();
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => resolve());
	});
	const address = server.address();
	if (typeof address !== "object" || address === null) throw new Error("Could not allocate a local port");
	await new Promise<void>((resolve, reject) => {
		server.close((error) => {
			if (error) {
				reject(error);
			} else {
				resolve();
			}
		});
	});
	return address.port;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasSession(sessions: unknown[], sessionId: string): boolean {
	return sessions.some((session) => isRecord(session) && session.id === sessionId);
}

function hasSearchResult(results: unknown[], sessionId: string): boolean {
	return results.some((result) => isRecord(result) && result.sessionId === sessionId);
}

function arrayProperty(value: Record<string, unknown>, key: string): unknown[] {
	const item = value[key];
	if (!Array.isArray(item)) throw new Error(`Expected ${key} array: ${JSON.stringify(value)}`);
	return item;
}

function nestedRecord(value: Record<string, unknown>, key: string): Record<string, unknown> {
	const item = value[key];
	if (!isRecord(item)) throw new Error(`Expected ${key} object: ${JSON.stringify(value)}`);
	return item;
}

function stringProperty(value: Record<string, unknown>, key: string): string | undefined {
	const item = value[key];
	return typeof item === "string" && item.trim().length > 0 ? item : undefined;
}

function hasNestedRecordValue(
	value: Record<string, unknown>,
	key: string,
	nestedKey: string,
	expected: string,
): boolean {
	const nested = value[key];
	return isRecord(nested) && nested[nestedKey] === expected;
}

function hasNamedItem(items: unknown[], name: string): boolean {
	return items.some((item) => isRecord(item) && item.name === name);
}

function hasIdItem(items: unknown[], id: string): boolean {
	return items.some((item) => isRecord(item) && item.id === id);
}

function hasCronJob(items: unknown[], jobId: string): boolean {
	return items.some((item) => isRecord(item) && item.id === jobId);
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

async function startLinearServer(): Promise<LinearServer> {
	const requests: LinearRequest[] = [];
	const server = createHttpServer(async (request, response) => {
		let body = "";
		for await (const chunk of request) body += chunk.toString("utf8");
		requests.push({ authorization: request.headers.authorization ?? null, body });
		const input = requestInput(body);
		response.writeHead(200, { "content-type": "application/json" });
		if (requestQuery(body).includes("issueCreate")) {
			response.end(
				JSON.stringify({
					data: {
						issueCreate: {
							success: input.teamId === "team-http" && input.title === "Created through HTTP smoke",
							issue: {
								id: "issue-http",
								identifier: "HTTP-100",
								title: input.title,
								url: "https://linear.example/HTTP-100",
								team: {
									id: input.teamId,
								},
							},
						},
					},
				}),
			);
			return;
		}
		response.end(
			JSON.stringify({
				data: {
					commentCreate: {
						success: input.issueId === "PROJ-HTTP-OUTBOX" && input.body === "HTTP pending comment",
						comment: {
							id: "comment-http",
							url: "https://linear.example/comment-http",
							issue: {
								id: input.issueId,
								identifier: input.issueId,
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
	if (typeof address !== "object" || address === null) throw new Error("Could not bind Linear HTTP smoke server");
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

function requestQuery(body: string): string {
	const parsed = JSON.parse(body) as unknown;
	const query = isRecord(parsed) ? parsed.query : undefined;
	if (typeof query !== "string") throw new Error(`Linear request did not include query: ${body}`);
	return query;
}

function requestInput(body: string): Record<string, unknown> {
	const parsed = JSON.parse(body) as unknown;
	const variables = isRecord(parsed) ? parsed.variables : undefined;
	const input = isRecord(variables) ? variables.input : undefined;
	if (!isRecord(input)) throw new Error(`Linear request did not include input: ${body}`);
	return input;
}

function restoreEnv(key: string, value: string | undefined): void {
	if (value === undefined) {
		delete process.env[key];
	} else {
		process.env[key] = value;
	}
}
