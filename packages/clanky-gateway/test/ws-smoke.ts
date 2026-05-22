import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gatewayEvent, startGatewayServer } from "@clanky/gateway";
import { type Api, type AssistantMessage, createAssistantMessageEventStream, type Model } from "@earendil-works/pi-ai";
import WebSocket, { type RawData } from "ws";

const provider = "clanky-ws-faux";
const model = "clanky-ws-faux-model";
const api = "clanky-ws-faux-api";
const expected = "WebSocket faux response from Clanky.";
const fauxState = { callCount: 0 };
const homeDir = await mkdtemp(join(tmpdir(), "clanky-ws-"));
const port = await freePort();
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
					name: "Clanky WebSocket Faux Model",
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
let socket: WebSocket | undefined;
let filteredSocket: WebSocket | undefined;

try {
	const token = (await readFile(server.registry.paths.httpTokenFile, "utf8")).trim();
	const baseUrl = `http://127.0.0.1:${port}`;
	await expectWebSocketRejected(`ws://127.0.0.1:${port}/events`);
	await expectWebSocketRejected(`ws://127.0.0.1:${port}/events?token=bad-token`);
	socket = new WebSocket(`ws://127.0.0.1:${port}/events?token=${encodeURIComponent(token)}`);
	const connectedPromise = nextEvent(socket, (event) => property(event, "type") === "connected");
	await once(socket, "open");

	const connected = await connectedPromise;
	if (property(connected, "type") !== "connected") {
		throw new Error("WebSocket did not emit connected event");
	}

	const changedPromise = nextEvent(
		socket,
		(event) => property(event, "type") === "cron.changed" && property(event, "action") === "add",
	);
	const created = await fetchJson(`${baseUrl}/cron/jobs`, token, {
		method: "POST",
		body: JSON.stringify({
			schedule: "2099-01-01T00:00:00.000Z",
			prompt: "future ws smoke",
			deliver: "file",
			provider,
			model,
			enabled: false,
		}),
		headers: {
			"Content-Type": "application/json",
		},
	});
	const createdJob = property(created, "job");
	if (!isRecord(createdJob) || typeof createdJob.id !== "string") {
		throw new Error("HTTP cron create returned unexpected payload");
	}

	const changed = await changedPromise;
	if (property(changed, "jobId") !== createdJob.id) {
		throw new Error("WebSocket cron.changed event did not reference the created job");
	}

	const ranPromise = nextEvent(
		socket,
		(event) =>
			property(event, "type") === "cron.ran" &&
			property(event, "jobId") === createdJob.id &&
			property(event, "ok") === true,
	);
	const firedPromise = nextEvent(
		socket,
		(event) =>
			property(event, "type") === "cron.fired" &&
			property(event, "jobId") === createdJob.id &&
			property(event, "ok") === true,
	);
	const cronRun = await fetchJson(`${baseUrl}/cron/jobs/${createdJob.id}/run`, token, { method: "POST" });
	const cronResult = property(cronRun, "result");
	if (!isRecord(cronResult) || property(cronResult, "text") !== expected) {
		throw new Error(`HTTP cron run returned unexpected payload: ${JSON.stringify(cronRun)}`);
	}
	await ranPromise;
	await firedPromise;

	const startedPromise = nextEvent(socket, (event) => property(event, "type") === "session.started");
	const deltaPromise = nextEvent(
		socket,
		(event) => property(event, "type") === "session.text_delta" && property(event, "delta") === expected,
	);
	const completedPromise = nextEvent(socket, (event) => property(event, "type") === "session.completed");
	const sent = await fetchJson(`${baseUrl}/sessions/new/messages`, token, {
		method: "POST",
		body: JSON.stringify({
			prompt: "exercise ws session stream",
			provider,
			model,
		}),
		headers: {
			"Content-Type": "application/json",
		},
	});
	const sentSessionId = property(sent, "sessionId");
	if (typeof sentSessionId !== "string" || property(sent, "text") !== expected) {
		throw new Error(`HTTP send returned unexpected payload: ${JSON.stringify(sent)}`);
	}

	const started = await startedPromise;
	const delta = await deltaPromise;
	const completed = await completedPromise;
	for (const event of [started, delta, completed]) {
		if (property(event, "sessionId") !== sentSessionId) {
			throw new Error(`WebSocket session event had unexpected session id: ${JSON.stringify(event)}`);
		}
	}

	const swarmPromise = nextEvent(
		socket,
		(event) =>
			property(event, "type") === "swarm.activity" && stringArrayProperty(event, "changes").includes("task.changed"),
	);
	const swarmTaskChangedPromise = nextEvent(
		socket,
		(event) =>
			property(event, "type") === "swarm.task_changed" &&
			stringArrayProperty(event, "changes").includes("task.changed"),
	);
	const swarmMessagePromise = nextEvent(
		socket,
		(event) =>
			property(event, "type") === "swarm.message" && stringArrayProperty(event, "changes").includes("new_messages"),
	);
	server.events.publish(
		gatewayEvent({
			type: "swarm.activity",
			changes: ["task.changed", "new_messages"],
			activity: {
				task_id: "task-ws",
				messages: [{ content: "plan-named websocket message alias" }],
			},
			instanceId: "clanky-ws-faux-gateway",
		}),
	);
	const swarm = await swarmPromise;
	const swarmTaskChanged = await swarmTaskChangedPromise;
	const swarmMessage = await swarmMessagePromise;
	if (property(swarm, "instanceId") !== "clanky-ws-faux-gateway") {
		throw new Error(`WebSocket swarm.activity event had unexpected payload: ${JSON.stringify(swarm)}`);
	}
	for (const event of [swarmTaskChanged, swarmMessage]) {
		if (property(event, "instanceId") !== "clanky-ws-faux-gateway") {
			throw new Error(`WebSocket swarm compatibility event had unexpected payload: ${JSON.stringify(event)}`);
		}
	}

	filteredSocket = new WebSocket(
		`ws://127.0.0.1:${port}/events?token=${encodeURIComponent(token)}&sessionId=${encodeURIComponent(sentSessionId)}`,
	);
	const filteredConnectedPromise = nextEvent(filteredSocket, (event) => property(event, "type") === "connected");
	await once(filteredSocket, "open");
	await filteredConnectedPromise;
	const filteredProbePromise = nextExpectedEvent(
		filteredSocket,
		(event) => property(event, "type") === "cron.changed" && property(event, "jobId") === "filtered-probe",
		(event) => property(event, "type") === "session.completed" && property(event, "sessionId") === "other-session",
	);
	server.events.publish(
		gatewayEvent({
			type: "session.completed",
			sessionId: "other-session",
		}),
	);
	server.events.publish(
		gatewayEvent({
			type: "cron.changed",
			action: "add",
			jobId: "filtered-probe",
		}),
	);
	await filteredProbePromise;

	const listed = await fetchJson(`${baseUrl}/cron/jobs`, token);
	const jobs = property(listed, "jobs");
	if (!Array.isArray(jobs) || jobs.length !== 1) {
		throw new Error("HTTP cron list returned unexpected payload");
	}

	console.log(
		JSON.stringify({
			cronEvent: property(changed, "type"),
			sessionEvent: property(completed, "type"),
			swarmEvent: property(swarm, "type"),
			jobId: createdJob.id,
			sessionId: sentSessionId,
			jobs: jobs.length,
			callCount: fauxState.callCount,
		}),
	);
} finally {
	socket?.close();
	filteredSocket?.close();
	await server.close();
	await rm(homeDir, { force: true, recursive: true });
}

async function fetchJson(url: string, token: string, init: RequestInit = {}): Promise<unknown> {
	const headers = new Headers(init.headers);
	headers.set("Authorization", `Bearer ${token}`);
	const response = await fetch(url, { ...init, headers });
	if (!response.ok) throw new Error(`${url} returned ${response.status}`);
	return (await response.json()) as unknown;
}

async function nextEvent(socket: WebSocket, predicate: (event: unknown) => boolean): Promise<unknown> {
	return await new Promise<unknown>((resolve, reject) => {
		const timeout = setTimeout(() => {
			socket.off("message", onMessage);
			reject(new Error("Timed out waiting for WebSocket event"));
		}, 5000);
		const onMessage = (data: RawData) => {
			const parsed = JSON.parse(data.toString()) as unknown;
			if (!predicate(parsed)) return;
			clearTimeout(timeout);
			socket.off("message", onMessage);
			resolve(parsed);
		};
		socket.on("message", onMessage);
	});
}

async function nextExpectedEvent(
	socket: WebSocket,
	expected: (event: unknown) => boolean,
	unexpected: (event: unknown) => boolean,
): Promise<unknown> {
	return await new Promise<unknown>((resolve, reject) => {
		const timeout = setTimeout(() => {
			socket.off("message", onMessage);
			reject(new Error("Timed out waiting for expected WebSocket event"));
		}, 5000);
		const onMessage = (data: RawData) => {
			const parsed = JSON.parse(data.toString()) as unknown;
			if (unexpected(parsed)) {
				clearTimeout(timeout);
				socket.off("message", onMessage);
				reject(new Error(`Received unexpected WebSocket event: ${JSON.stringify(parsed)}`));
				return;
			}
			if (!expected(parsed)) return;
			clearTimeout(timeout);
			socket.off("message", onMessage);
			resolve(parsed);
		};
		socket.on("message", onMessage);
	});
}

async function expectWebSocketRejected(url: string): Promise<void> {
	const rejected = new WebSocket(url);
	try {
		const message = await new Promise<string>((resolve, reject) => {
			let settled = false;
			const finish = (result: string) => {
				if (settled) return;
				settled = true;
				clearTimeout(timeout);
				resolve(result);
			};
			const timeout = setTimeout(() => {
				if (settled) return;
				settled = true;
				reject(new Error(`Timed out waiting for WebSocket auth rejection: ${url}`));
			}, 5000);
			rejected.once("open", () => {
				if (settled) return;
				settled = true;
				clearTimeout(timeout);
				reject(new Error(`Unauthorized WebSocket unexpectedly opened: ${url}`));
			});
			rejected.once("unexpected-response", (_request, response) => {
				response.resume();
				finish(`status:${response.statusCode}`);
			});
			rejected.once("error", (error) => {
				finish(error.message);
			});
		});
		if (!message.includes("401")) {
			throw new Error(`Unauthorized WebSocket returned unexpected rejection: ${message}`);
		}
	} finally {
		rejected.close();
	}
}

async function once(socket: WebSocket, event: "open"): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		socket.once(event, resolve);
		socket.once("error", reject);
	});
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
	const server = createServer();
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

function property(value: unknown, key: string): unknown {
	if (!isRecord(value)) return undefined;
	return value[key];
}

function stringArrayProperty(value: unknown, key: string): string[] {
	const item = property(value, key);
	if (!Array.isArray(item)) return [];
	return item.filter((entry) => typeof entry === "string");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
