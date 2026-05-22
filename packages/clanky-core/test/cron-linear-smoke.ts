import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CronJobStore, CronScheduler, SessionRegistry } from "@clanky/core";
import { type Api, type AssistantMessage, createAssistantMessageEventStream, type Model } from "@earendil-works/pi-ai";

const provider = "clanky-cron-faux";
const model = "clanky-cron-faux-summary";
const api = "clanky-cron-faux-api";
const issueId = "PROJ-123";
const expected = "Cron summary for Linear from faux model.";
const homeDir = await mkdtemp(join(tmpdir(), "clanky-cron-linear-"));
const fauxState = { callCount: 0 };

const linear = await startLinearServer(issueId);
const registry = new SessionRegistry({
	homeDir,
	configureModelRegistry: (modelRegistry) => {
		modelRegistry.registerProvider(provider, {
			api,
			baseUrl: "http://localhost:0",
			apiKey: "test-key",
			streamSimple: (streamModel) => createFauxStream(streamModel, expected, fauxState),
			models: [
				{
					id: model,
					name: "Clanky Cron Faux Summary",
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
const store = new CronJobStore(registry.paths);
const scheduler = new CronScheduler({ registry, store });
const previousLinearApiKey = process.env.LINEAR_API_KEY;
const previousLinearEndpoint = process.env.LINEAR_GRAPHQL_ENDPOINT;
process.env.LINEAR_API_KEY = "linear-key";
process.env.LINEAR_GRAPHQL_ENDPOINT = linear.endpoint;

try {
	await registry.start();
	const job = await store.add(
		{
			schedule: "2026-01-01T00:00:01.000Z",
			prompt: "scan recent commits and post a summary to Linear PROJ-123",
			deliver: `linear:${issueId}`,
			provider,
			model,
			idempotencyKey: "cron-linear-$" + "{ISO}",
		},
		new Date("2026-01-01T00:00:00.000Z"),
	);
	const tick = await scheduler.tick(new Date("2026-01-01T00:00:02.000Z"));
	const run = tick.ran[0];
	if (tick.skipped || tick.ran.length !== 1 || run === undefined || !run.ok) {
		throw new Error(`Expected one cron Linear job to run successfully: ${JSON.stringify(tick)}`);
	}
	if (run.text !== expected || run.deliveredTo !== `linear:${issueId}` || run.linearOutboxId === undefined) {
		throw new Error(`Cron Linear run returned unexpected delivery result: ${JSON.stringify(run)}`);
	}
	if (run.outputFile === undefined || (await readFile(run.outputFile, "utf8")) !== expected) {
		throw new Error("Cron Linear output file did not contain the faux model response");
	}
	const [outboxEntry] = await registry.listLinearOutbox();
	if (outboxEntry === undefined || outboxEntry.status !== "posted" || outboxEntry.issueId !== issueId) {
		throw new Error("Cron Linear delivery did not create and post a Linear outbox entry");
	}
	const [request] = linear.requests;
	if (request === undefined || !request.body.includes(expected) || request.authorization !== "linear-key") {
		throw new Error("Cron Linear delivery did not post the expected Linear request");
	}
	const [updatedJob] = await store.list();
	if (updatedJob?.id !== job.id || updatedJob.enabled || updatedJob.lastStatus !== "ok") {
		throw new Error("Cron Linear one-shot job was not advanced cleanly after successful run");
	}

	console.log(JSON.stringify({ jobId: job.id, posted: linear.requests.length, callCount: fauxState.callCount }));
} finally {
	restoreEnv("LINEAR_API_KEY", previousLinearApiKey);
	restoreEnv("LINEAR_GRAPHQL_ENDPOINT", previousLinearEndpoint);
	await registry.dispose();
	await linear.close();
	await rm(homeDir, { force: true, recursive: true });
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

interface LinearRequest {
	authorization: string | undefined;
	body: string;
}

interface LinearServer {
	endpoint: string;
	requests: LinearRequest[];
	close(): Promise<void>;
}

async function startLinearServer(expectedIssueId: string): Promise<LinearServer> {
	const requests: LinearRequest[] = [];
	const server = createServer((request: IncomingMessage, response: ServerResponse) => {
		let body = "";
		request.on("data", (chunk) => {
			body += chunk.toString("utf8");
		});
		request.on("end", () => {
			requests.push({ authorization: request.headers.authorization, body });
			const issueId = readIssueId(body) ?? expectedIssueId;
			response.writeHead(200, { "content-type": "application/json" });
			response.end(
				JSON.stringify({
					data: {
						commentCreate: {
							success: true,
							comment: {
								id: `comment-${requests.length}`,
								url: `http://linear.local/comment-${requests.length}`,
								issue: {
									id: issueId,
									identifier: issueId,
								},
							},
						},
					},
				}),
			);
		});
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => resolve());
	});
	const address = server.address();
	if (typeof address !== "object" || address === null) throw new Error("Could not bind Linear smoke server");
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

function readIssueId(body: string): string | undefined {
	const parsed = JSON.parse(body) as unknown;
	const variables = property(parsed, "variables");
	const input = property(variables, "input");
	const issueId = property(input, "issueId");
	return typeof issueId === "string" ? issueId : undefined;
}

function property(value: unknown, key: string): unknown {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	return (value as Record<string, unknown>)[key];
}

function restoreEnv(key: "LINEAR_API_KEY" | "LINEAR_GRAPHQL_ENDPOINT", value: string | undefined): void {
	if (value === undefined) {
		delete process.env[key];
		return;
	}
	process.env[key] = value;
}
