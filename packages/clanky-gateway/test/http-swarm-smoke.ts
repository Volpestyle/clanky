import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startGatewayServer } from "@clanky/gateway";

const homeDir = await mkdtemp(join(tmpdir(), "clanky-http-swarm-"));
const port = await freePort();
const previousEnv = captureEnv(
	"CLANKY_SWARM_ENABLED",
	"CLANKY_SWARM_COMMAND",
	"CLANKY_SWARM_ARGS_JSON",
	"AGENT_IDENTITY",
);
process.env.CLANKY_SWARM_ENABLED = "1";
process.env.CLANKY_SWARM_COMMAND = process.execPath;
process.env.CLANKY_SWARM_ARGS_JSON = JSON.stringify([
	"--import",
	"tsx",
	"packages/clanky-swarm/test/faux-swarm-mcp.ts",
]);
process.env.AGENT_IDENTITY = "http-swarm-smoke";

const server = await startGatewayServer({ homeDir, http: { hostname: "127.0.0.1", port } });

try {
	const baseUrl = `http://127.0.0.1:${port}`;
	const token = (await readFile(server.registry.paths.httpTokenFile, "utf8")).trim();
	if (token.length === 0) throw new Error("HTTP token file was empty");

	const status = await fetchRecord(`${baseUrl}/swarm/status`, token);
	if (status.state !== "booted" || status.instanceId !== "clanky-faux-gateway") {
		throw new Error(`HTTP /swarm/status returned unexpected payload: ${JSON.stringify(status)}`);
	}

	const peers = await fetchRecord(`${baseUrl}/swarm/peers`, token);
	if (peers.ok !== true || !hasSwarmItem(arrayProperty(peers, "data"), "clanky-faux-worker")) {
		throw new Error(`HTTP /swarm/peers returned unexpected payload: ${JSON.stringify(peers)}`);
	}

	const tasks = await fetchRecord(`${baseUrl}/swarm/tasks`, token);
	if (tasks.ok !== true || !hasSwarmItem(arrayProperty(tasks, "data"), "task-1")) {
		throw new Error(`HTTP /swarm/tasks returned unexpected payload: ${JSON.stringify(tasks)}`);
	}

	const snapshot = await fetchRecord(`${baseUrl}/swarm/snapshot`, token);
	if (
		snapshot.ok !== true ||
		!hasSwarmItem(arrayProperty(snapshot, "instances"), "clanky-faux-gateway") ||
		!hasSwarmItem(arrayProperty(snapshot, "tasks"), "task-1")
	) {
		throw new Error(`HTTP /swarm/snapshot returned unexpected payload: ${JSON.stringify(snapshot)}`);
	}

	const message = await fetchRecord(`${baseUrl}/swarm/message`, token, {
		method: "POST",
		body: {
			recipient: "clanky-faux-worker",
			message: "HTTP swarm smoke message.",
			task_id: "task-1",
			nudge: false,
			force: true,
		},
	});
	const messageRequest = property(message, "request");
	if (
		message.ok !== true ||
		!isRecord(messageRequest) ||
		messageRequest.recipient !== "clanky-faux-worker" ||
		messageRequest.taskId !== "task-1" ||
		messageRequest.nudge !== false ||
		messageRequest.force !== true
	) {
		throw new Error(`HTTP /swarm/message returned unexpected payload: ${JSON.stringify(message)}`);
	}

	const dispatch = await fetchRecord(`${baseUrl}/swarm/dispatch`, token, {
		method: "POST",
		body: {
			title: "HTTP faux dispatch",
			type: "implement",
			description: "Exercise Clanky HTTP swarm dispatch.",
			files: ["README.md"],
			provider: "anthropic",
			model: "claude-opus-4-5",
			linear_issue: "PROJ-456",
			idempotency_key: "http-swarm-smoke-1",
		},
	});
	if (dispatch.ok !== true || dispatch.taskId !== "task-1" || dispatch.dispatchStatus !== "dispatched") {
		throw new Error(`HTTP /swarm/dispatch returned unexpected payload: ${JSON.stringify(dispatch)}`);
	}
	if (!JSON.stringify(dispatch).includes("claude-opus-4-5")) {
		throw new Error(`HTTP /swarm/dispatch did not preserve model override: ${JSON.stringify(dispatch)}`);
	}
	const duplicateDispatch = await fetchRecord(`${baseUrl}/swarm/dispatch`, token, {
		method: "POST",
		body: {
			title: "HTTP faux dispatch duplicate",
			type: "implement",
			description: "Exercise Clanky HTTP swarm dispatch idempotency.",
			files: ["README.md"],
			linear_issue: "PROJ-456",
			idempotency_key: "http-swarm-smoke-1",
		},
	});
	const duplicateResponse = property(duplicateDispatch, "response");
	if (
		duplicateDispatch.ok !== true ||
		duplicateDispatch.taskId !== "task-1" ||
		duplicateDispatch.dispatchStatus !== "dispatched" ||
		property(duplicateResponse, "deduplicated") !== true
	) {
		throw new Error(`HTTP /swarm/dispatch did not preserve idempotency: ${JSON.stringify(duplicateDispatch)}`);
	}

	const linear = await fetchRecord(`${baseUrl}/linear/links`, token);
	const links = arrayProperty(linear, "links");
	const [link] = links;
	if (!isRecord(link) || link.issueId !== "PROJ-456" || link.taskId !== "task-1") {
		throw new Error(`HTTP /swarm/dispatch did not persist a Linear task link: ${JSON.stringify(linear)}`);
	}

	const lock = await fetchRecord(`${baseUrl}/swarm/file-lock?file=locked-file.ts`, token);
	if (lock.ok !== true || lock.blocked !== true || lock.ownerId !== "clanky-faux-worker") {
		throw new Error(`HTTP /swarm/file-lock did not return a blocking peer lock: ${JSON.stringify(lock)}`);
	}

	const complete = await fetchRecord(`${baseUrl}/swarm/complete`, token, {
		method: "POST",
		body: {
			taskId: "task-1",
			summary: "Completed through HTTP.",
			filesChanged: ["README.md"],
			tests: [{ command: "pnpm check", status: "passed" }],
		},
	});
	if (complete.ok !== true) {
		throw new Error(`HTTP /swarm/complete failed: ${JSON.stringify(complete)}`);
	}
	const request = property(complete, "request");
	const trackerUpdateSkipped = property(request, "trackerUpdateSkipped");
	if (!isRecord(trackerUpdateSkipped) || typeof trackerUpdateSkipped.reason !== "string") {
		throw new Error(`HTTP /swarm/complete did not add tracker_update_skipped fallback: ${JSON.stringify(complete)}`);
	}
	const outboxEntries = arrayProperty(complete, "linearOutboxEntries");
	const [entry] = outboxEntries;
	if (!isRecord(entry) || entry.issueId !== "PROJ-456" || entry.taskId !== "task-1" || entry.status !== "pending") {
		throw new Error(`HTTP /swarm/complete did not mirror completion to Linear outbox: ${JSON.stringify(complete)}`);
	}
	if (typeof entry.body !== "string" || !entry.body.includes("Tracker update skipped:")) {
		throw new Error(`HTTP /swarm/complete did not mirror tracker skip into Linear: ${JSON.stringify(complete)}`);
	}

	console.log(
		JSON.stringify({
			port,
			taskId: dispatch.taskId,
			links: links.length,
			outbox: outboxEntries.length,
			deduplicated: property(duplicateResponse, "deduplicated"),
			lockBlocked: lock.blocked,
		}),
	);
} finally {
	await server.close();
	restoreEnv(previousEnv);
	await rm(homeDir, { force: true, recursive: true });
}

interface FetchJsonOptions {
	method?: string;
	body?: unknown;
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

async function fetchJson(url: string, token: string, options: FetchJsonOptions = {}): Promise<unknown> {
	const headers = new Headers({
		Authorization: `Bearer ${token}`,
	});
	if (options.body !== undefined) headers.set("content-type", "application/json");
	const request: RequestInit = { headers };
	if (options.method !== undefined) request.method = options.method;
	if (options.body !== undefined) request.body = JSON.stringify(options.body);
	const response = await fetch(url, request);
	if (!response.ok) throw new Error(`${url} returned ${response.status}: ${await response.text()}`);
	return (await response.json()) as unknown;
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

function arrayProperty(value: Record<string, unknown>, key: string): unknown[] {
	const item = value[key];
	if (!Array.isArray(item)) throw new Error(`Expected ${key} array: ${JSON.stringify(value)}`);
	return item;
}

function hasSwarmItem(items: unknown[], id: string): boolean {
	return items.some((item) => isRecord(item) && (item.id === id || item.instance_id === id || item.task_id === id));
}

function property(value: unknown, key: string): unknown {
	if (!isRecord(value)) return undefined;
	return value[key];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function captureEnv(...keys: string[]): Map<string, string | undefined> {
	const values = new Map<string, string | undefined>();
	for (const key of keys) values.set(key, process.env[key]);
	return values;
}

function restoreEnv(values: Map<string, string | undefined>): void {
	for (const [key, value] of values) {
		if (value === undefined) {
			delete process.env[key];
		} else {
			process.env[key] = value;
		}
	}
}
