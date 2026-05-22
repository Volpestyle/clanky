import { type ChildProcessByStdio, spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { gatewayEvent, startGatewayServer } from "@clanky/gateway";

type DashboardChild = ChildProcessByStdio<null, Readable, Readable>;

const homeDir = await mkdtemp(join(tmpdir(), "clanky-dashboard-watch-"));
const port = await freePort();
const server = await startGatewayServer({ homeDir, http: { hostname: "127.0.0.1", port } });
let child: DashboardChild | undefined;

try {
	const token = (await readFile(server.registry.paths.httpTokenFile, "utf8")).trim();
	const spawned = spawn(
		process.execPath,
		[
			"--import",
			"tsx",
			"packages/clanky-cli/src/bin.ts",
			"tui",
			"--home",
			homeDir,
			"--watch",
			"--http",
			`127.0.0.1:${port}`,
		],
		{
			cwd: process.cwd(),
			stdio: ["ignore", "pipe", "pipe"],
		},
	);
	child = spawned;
	const output = captureOutput(spawned);
	await waitFor(() => output.stdout.includes("Clanky Dashboard"));

	const created = await fetchJson(`http://127.0.0.1:${port}/cron/jobs`, token, {
		method: "POST",
		body: JSON.stringify({
			schedule: "2099-01-01T00:00:00.000Z",
			prompt: "dashboard watch smoke",
			deliver: "file",
			enabled: false,
		}),
		headers: {
			"Content-Type": "application/json",
		},
	});
	const job = property(created, "job");
	const jobId = isRecord(job) ? stringProperty(job, "id") : undefined;
	if (jobId === undefined) {
		throw new Error(`HTTP cron create returned unexpected payload: ${JSON.stringify(created)}`);
	}

	await waitFor(() => output.stdout.includes(jobId.slice(0, 8)));

	const session = await server.registry.createSession();
	const sessionStartedEvent: Parameters<typeof gatewayEvent>[0] = {
		type: "session.started",
		sessionId: session.id,
	};
	if (session.sessionFile !== undefined) sessionStartedEvent.sessionFile = session.sessionFile;
	server.events.publish(gatewayEvent(sessionStartedEvent));
	await waitFor(() => output.stdout.includes(session.id.slice(0, 8)));

	const task = await server.registry.createTask({
		title: "Dashboard watch cron refresh task",
		status: "in_progress",
		priority: "high",
		sessionId: session.id,
	});
	server.events.publish(
		gatewayEvent({
			type: "cron.changed",
			action: "add",
			jobId: task.id,
		}),
	);
	await waitFor(() => output.stdout.includes("Dashboard watch cron refresh task"));
	spawned.kill("SIGTERM");
	const close = await waitForClose(spawned);
	if (close.code !== 0 && close.signal !== "SIGTERM") {
		throw new Error(`dashboard watch exited unexpectedly: ${JSON.stringify(close)}\n${output.stderr}`);
	}

	console.log(
		JSON.stringify({ watch: true, jobId, sessionId: session.id, taskId: task.id, stdoutBytes: output.stdout.length }),
	);
} finally {
	child?.kill("SIGTERM");
	await server.close();
	await rm(homeDir, { force: true, recursive: true });
}

interface CapturedOutput {
	stdout: string;
	stderr: string;
}

function captureOutput(child: DashboardChild): CapturedOutput {
	const output: CapturedOutput = { stdout: "", stderr: "" };
	child.stdout.on("data", (chunk) => {
		output.stdout += chunk.toString("utf8");
	});
	child.stderr.on("data", (chunk) => {
		output.stderr += chunk.toString("utf8");
	});
	return output;
}

async function fetchJson(url: string, token: string, init: RequestInit = {}): Promise<unknown> {
	const headers = new Headers(init.headers);
	headers.set("Authorization", `Bearer ${token}`);
	const response = await fetch(url, { ...init, headers });
	if (!response.ok) throw new Error(`${url} returned ${response.status}: ${await response.text()}`);
	return (await response.json()) as unknown;
}

async function waitFor(predicate: () => boolean): Promise<void> {
	const deadline = Date.now() + 5000;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	throw new Error("Timed out waiting for dashboard watch output");
}

async function waitForClose(child: DashboardChild): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
	return await new Promise((resolve, reject) => {
		const timeout = setTimeout(() => {
			child.kill("SIGKILL");
			reject(new Error("Timed out waiting for dashboard watch child to close"));
		}, 5000);
		child.once("error", (error) => {
			clearTimeout(timeout);
			reject(error);
		});
		child.once("close", (code, signal) => {
			clearTimeout(timeout);
			resolve({ code, signal });
		});
	});
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

function stringProperty(value: Record<string, unknown>, key: string): string | undefined {
	const item = value[key];
	return typeof item === "string" && item.trim().length > 0 ? item : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
