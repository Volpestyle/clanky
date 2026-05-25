import { Buffer } from "node:buffer";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AuthSetApiKeyResult, type AuthStatusResult, requestGateway, startGatewayServer } from "@clanky/gateway";
import { dashboardSessionIdForKey, renderDashboard } from "../src/dashboard.ts";

const homeDir = await mkdtemp(join(tmpdir(), "clanky-dashboard-"));
const previousEnv = captureEnv("AGENT_IDENTITY", "OPENAI_API_KEY", "CLANKY_OPENAI_OAUTH_ISSUER");
process.env.AGENT_IDENTITY = "dashboard-smoke";
delete process.env.OPENAI_API_KEY;
const oauthServer = await startFakeOpenAiOAuthServer();
process.env.CLANKY_OPENAI_OAUTH_ISSUER = oauthServer.issuer;
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
		"Actions: [c] chat  [a] OpenAI auth/OAuth  [1-8] resume  [q] quit",
		"Daemon: running",
		"Model Auth",
		"OpenAI: missing",
		"OpenAI Codex OAuth: missing",
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
	const oauthBegin = (await requestGateway({
		socketFile: server.socketFile,
		method: "auth.oauth.begin",
		params: { provider: "openai-codex" },
	})) as { loginId: string; userCode: string; verificationUrl: string };
	if (oauthBegin.userCode !== "CLANKY-OAUTH") {
		throw new Error(`auth.oauth.begin returned unexpected payload: ${JSON.stringify(oauthBegin)}`);
	}
	const oauthResult = (await requestGateway({
		socketFile: server.socketFile,
		method: "auth.oauth.wait",
		params: { loginId: oauthBegin.loginId },
	})) as { provider: string; status: AuthStatusResult };
	if (oauthResult.provider !== "openai-codex" || !oauthResult.status.authProviders.includes("openai-codex")) {
		throw new Error(`auth.oauth.wait returned unexpected status: ${JSON.stringify(oauthResult)}`);
	}
	if (!session.session.modelRegistry.getAvailable().some((model) => model.provider === "openai-codex")) {
		throw new Error("Live dashboard session did not refresh OpenAI OAuth");
	}
	const oauthDashboard = await renderDashboard(server.socketFile);
	for (const expected of ["stored_providers=openai,openai-codex", "OpenAI Codex OAuth: stored"]) {
		if (!oauthDashboard.includes(expected)) {
			throw new Error(`OAuth dashboard output missing ${expected}\n${oauthDashboard}`);
		}
	}
	if (oauthDashboard.includes("clanky-oauth-access")) {
		throw new Error("Dashboard leaked the stored OpenAI OAuth token");
	}
	await requestGateway({
		socketFile: server.socketFile,
		method: "auth.remove",
		params: { provider: "openai-codex" },
	});
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
	await oauthServer.close();
	restoreEnv(previousEnv);
	await rm(homeDir, { force: true, recursive: true });
}

interface FakeOAuthServer {
	close(): Promise<void>;
	issuer: string;
}

async function startFakeOpenAiOAuthServer(): Promise<FakeOAuthServer> {
	const server = createServer((request, response) => {
		handleFakeOAuthRequest(request, response).catch((error: unknown) => {
			response.statusCode = 500;
			response.end(error instanceof Error ? error.message : String(error));
		});
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => resolve());
	});
	const address = server.address();
	if (typeof address !== "object" || address === null) throw new Error("Fake OAuth server did not bind to a port");
	return {
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
		issuer: `http://127.0.0.1:${address.port}`,
	};
}

async function handleFakeOAuthRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
	const chunks: Buffer[] = [];
	for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
	const body = Buffer.concat(chunks).toString("utf8");
	if (request.method === "POST" && request.url === "/api/accounts/deviceauth/usercode") {
		writeJson(response, {
			device_auth_id: "device-clanky-oauth",
			expires_in: 60,
			interval: 0.01,
			user_code: "CLANKY-OAUTH",
			verification_uri: "https://auth.openai.com/codex/device",
		});
		return;
	}
	if (request.method === "POST" && request.url === "/api/accounts/deviceauth/token") {
		if (!body.includes("device-clanky-oauth")) {
			writeJson(response, { error: "unknown_device" }, 400);
			return;
		}
		writeJson(response, {
			authorization_code: "authorization-clanky-oauth",
			code_verifier: "verifier-clanky-oauth",
		});
		return;
	}
	if (request.method === "POST" && request.url === "/oauth/token") {
		if (!body.includes("authorization-clanky-oauth")) {
			writeJson(response, { error: "invalid_grant" }, 400);
			return;
		}
		writeJson(response, {
			access_token: fakeJwt(),
			expires_in: 3600,
			refresh_token: "clanky-oauth-refresh",
		});
		return;
	}
	writeJson(response, { error: "not_found" }, 404);
}

function writeJson(response: ServerResponse, payload: Record<string, unknown>, status = 200): void {
	response.statusCode = status;
	response.setHeader("Content-Type", "application/json");
	response.end(JSON.stringify(payload));
}

function fakeJwt(): string {
	const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
	const payload = Buffer.from(
		JSON.stringify({
			exp: Math.floor(Date.now() / 1000) + 3600,
			"https://api.openai.com/auth": { chatgpt_account_id: "account-clanky-oauth" },
			sub: "clanky-oauth-access",
		}),
	).toString("base64url");
	return `${header}.${payload}.signature`;
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
