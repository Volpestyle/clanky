import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AuthSetApiKeyResult, type AuthStatusResult, requestGateway, startGatewayServer } from "@clanky/gateway";
import { dashboardSessionIdForKey, renderDashboard } from "../src/dashboard.ts";

const homeDir = await mkdtemp(join(tmpdir(), "clanky-dashboard-"));
const previousEnv = captureEnv("AGENT_IDENTITY", "OPENAI_API_KEY");
process.env.AGENT_IDENTITY = "dashboard-smoke";
delete process.env.OPENAI_API_KEY;
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
		"Actions: [a] OpenAI auth  [1-8] resume  [q] quit",
		"Daemon: running",
		"Model Auth",
		"OpenAI: missing",
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
	]) {
		if (!dashboard.includes(expected)) {
			throw new Error(`Dashboard output missing ${expected}\n${dashboard}`);
		}
	}
	const authResult = (await requestGateway({
		socketFile: server.socketFile,
		method: "auth.set_api_key",
		params: { provider: "openai", apiKey: "sk-dashboard-openai-smoke" },
	})) as AuthSetApiKeyResult;
	if (authResult.provider !== "openai" || !authResult.status.authProviders.includes("openai")) {
		throw new Error(`auth.set_api_key returned unexpected status: ${JSON.stringify(authResult)}`);
	}
	const authFile = await readFile(authResult.status.authFile, "utf8");
	if (!authFile.includes("sk-dashboard-openai-smoke")) {
		throw new Error("OpenAI key was not persisted to profile auth.json");
	}
	if (!session.session.modelRegistry.getAvailable().some((model) => model.provider === "openai")) {
		throw new Error("Live dashboard session did not refresh OpenAI auth");
	}
	const authedDashboard = await renderDashboard(server.socketFile);
	for (const expected of ["Model Auth", "credentials=set", "stored_providers=openai", "OpenAI: stored"]) {
		if (!authedDashboard.includes(expected)) {
			throw new Error(`Authed dashboard output missing ${expected}\n${authedDashboard}`);
		}
	}
	if (authedDashboard.includes("sk-dashboard-openai-smoke")) {
		throw new Error("Dashboard leaked the stored OpenAI API key");
	}
	await requestGateway({
		socketFile: server.socketFile,
		method: "auth.remove",
		params: { provider: "openai" },
	});
	const removedAuth = (await requestGateway({
		socketFile: server.socketFile,
		method: "auth.status",
	})) as AuthStatusResult;
	const openAi = removedAuth.providers.find((provider) => provider.provider === "openai");
	if (openAi?.configured) {
		throw new Error(`auth.remove did not clear OpenAI auth: ${JSON.stringify(openAi)}`);
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
