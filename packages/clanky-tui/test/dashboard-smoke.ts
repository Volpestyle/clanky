import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startGatewayServer } from "@clanky/gateway";
import { dashboardSessionIdForKey, renderDashboard } from "../src/dashboard.ts";

const homeDir = await mkdtemp(join(tmpdir(), "clanky-dashboard-"));
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
process.env.AGENT_IDENTITY = "dashboard-smoke";
const server = await startGatewayServer({ homeDir });

try {
	const session = await server.registry.createSession();
	const persisted = await server.registry.createSession({ noTools: "all" });
	persisted.session.sessionManager.appendMessage({
		role: "user",
		content: "Dashboard quick resume seeded session",
		timestamp: Date.now(),
	});
	persisted.session.sessionManager.appendMessage({
		role: "assistant",
		content: [{ type: "text", text: "Dashboard quick resume answer" }],
		api: "test",
		provider: "test",
		model: "test",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	});
	const persistedFile = await server.registry.refreshSessionFile(persisted.id);
	if (persistedFile === undefined) throw new Error("Dashboard quick-resume session did not persist");
	const job = await server.cron.addJob({
		schedule: "every 1h",
		prompt: "Summarize recent sessions.",
	});
	const task = await server.registry.createTask({
		title: "Dashboard local task",
		description: "Visible in dashboard task pane.",
		status: "in_progress",
		priority: "high",
		sessionId: persisted.id,
		linearIssue: "PROJ-DASH",
		source: "dashboard-smoke",
	});
	const dashboard = await renderDashboard(server.socketFile);
	for (const expected of [
		"Clanky Dashboard",
		"Daemon: running",
		"Sessions",
		session.id.slice(0, 8),
		`[-] ${session.id.slice(0, 8)}`,
		`[1] ${persisted.id.slice(0, 8)}`,
		"Tasks",
		task.id.slice(0, 8),
		"in_progress",
		"PROJ-DASH",
		persisted.id.slice(0, 8),
		"Dashboard local task",
		"Cron",
		job.id.slice(0, 8),
		"in ",
		"Swarm",
		"peer clanky-f",
		"worker role:implementer",
		"locks: held=1 blocking=1 warnings=0",
		"owned-file.ts",
		"locked-file.ts",
		"Faux task",
	]) {
		if (!dashboard.includes(expected)) {
			throw new Error(`Dashboard output missing ${expected}\n${dashboard}`);
		}
	}
	const selectedSessionId = dashboardSessionIdForKey(
		{
			sessions: [
				{
					id: session.id,
					cwd: process.cwd(),
					sessionFile: undefined,
					live: true,
				},
				{
					id: persisted.id,
					cwd: process.cwd(),
					sessionFile: persistedFile,
					live: true,
				},
			],
		},
		"1",
	);
	if (selectedSessionId !== persisted.id) {
		throw new Error(`Dashboard quick-resume key selected unexpected session: ${selectedSessionId}`);
	}

	console.log(JSON.stringify({ sessionId: session.id, jobId: job.id, bytes: dashboard.length }));
} finally {
	await server.close();
	restoreEnv(previousEnv);
	await rm(homeDir, { force: true, recursive: true });
}

function captureEnv(...names: string[]): Map<string, string | undefined> {
	return new Map(names.map((name) => [name, process.env[name]]));
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
