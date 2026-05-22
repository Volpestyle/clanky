import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type ExternalMcpCallResult,
	type ExternalMcpListResult,
	requestGateway,
	type StatusResult,
	startGatewayServer,
} from "@clanky/gateway";

const previousConfig = process.env.CLANKY_MCP_SERVERS_JSON;
const homeDir = await mkdtemp(join(tmpdir(), "clanky-external-mcp-"));
const port = await freePort();
process.env.CLANKY_MCP_SERVERS_JSON = JSON.stringify([
	{
		name: "faux",
		command: process.execPath,
		args: ["--import", "tsx", "packages/clanky-gateway/test/faux-external-mcp.ts"],
		cwd: process.cwd(),
		env: {
			CLANKY_FAUX_MCP_MARKER: "configured",
		},
	},
	{
		name: "broken",
		command: process.execPath,
		args: ["-e", "process.exit(42)"],
		cwd: process.cwd(),
	},
]);

const server = await startGatewayServer({ homeDir, http: { hostname: "127.0.0.1", port } });

try {
	const baseUrl = `http://127.0.0.1:${port}`;
	const token = (await readFile(server.registry.paths.httpTokenFile, "utf8")).trim();
	if (token.length === 0) throw new Error("HTTP token file was empty");
	const status = (await requestGateway({ socketFile: server.socketFile, method: "status" })) as StatusResult;
	const statusFaux = status.externalMcpServers.find((candidate) => candidate.name === "faux");
	const statusBroken = status.externalMcpServers.find((candidate) => candidate.name === "broken");
	if (status.externalMcpServers.length !== 2 || statusFaux?.state !== "booted" || statusBroken?.state !== "error") {
		throw new Error(
			`Expected one booted and one failed external MCP server in status: ${JSON.stringify(status.externalMcpServers)}`,
		);
	}
	if (!status.warnings.some((warning) => warning.includes("External MCP server broken failed:"))) {
		throw new Error(`Status did not warn about the failed external MCP server: ${JSON.stringify(status.warnings)}`);
	}

	const listed = (await requestGateway({ socketFile: server.socketFile, method: "mcp.list" })) as ExternalMcpListResult;
	const faux = listed.servers.find((candidate) => candidate.name === "faux");
	if (faux === undefined || faux.state !== "booted" || !faux.tools.some((tool) => tool.name === "echo")) {
		throw new Error(`External MCP list did not include faux echo tool: ${JSON.stringify(listed)}`);
	}
	const broken = listed.servers.find((candidate) => candidate.name === "broken");
	if (broken === undefined || broken.state !== "error" || broken.error === undefined) {
		throw new Error(`External MCP list did not include the failed server error: ${JSON.stringify(listed)}`);
	}

	const called = (await requestGateway({
		socketFile: server.socketFile,
		method: "mcp.call",
		params: {
			server: "faux",
			tool: "echo",
			arguments: { message: "hello external mcp" },
		},
	})) as ExternalMcpCallResult;
	const result = record(called.result);
	if (result.message !== "hello external mcp" || result.marker !== "configured") {
		throw new Error(`External MCP call returned unexpected result: ${JSON.stringify(called)}`);
	}
	await assertRejectsMcpCall(
		{
			server: "broken",
			tool: "echo",
			arguments: { message: "this should not call" },
		},
		"MCP server broken failed to boot",
	);

	const httpListed = await fetchRecord(`${baseUrl}/mcp/servers`, token);
	const httpServers = arrayProperty(httpListed, "servers");
	const httpFaux = httpServers.find((candidate) => record(candidate).name === "faux");
	if (httpFaux === undefined || record(httpFaux).state !== "booted") {
		throw new Error(`HTTP /mcp/servers did not include the booted faux server: ${JSON.stringify(httpListed)}`);
	}
	const httpBroken = httpServers.find((candidate) => record(candidate).name === "broken");
	if (httpBroken === undefined || record(httpBroken).state !== "error") {
		throw new Error(`HTTP /mcp/servers did not include the failed server: ${JSON.stringify(httpListed)}`);
	}
	const httpCalled = await fetchRecord(`${baseUrl}/mcp/call`, token, {
		method: "POST",
		body: {
			server: "faux",
			tool: "echo",
			arguments: { message: "hello http external mcp" },
		},
	});
	const httpResult = record(httpCalled.result);
	if (httpResult.message !== "hello http external mcp" || httpResult.marker !== "configured") {
		throw new Error(`HTTP /mcp/call returned unexpected result: ${JSON.stringify(httpCalled)}`);
	}

	console.log(
		JSON.stringify({
			servers: listed.servers.length,
			tools: faux.tools.length,
			brokenState: broken.state,
			message: result.message,
			httpMessage: httpResult.message,
		}),
	);
} finally {
	await server.close();
	restoreEnv("CLANKY_MCP_SERVERS_JSON", previousConfig);
	await rm(homeDir, { force: true, recursive: true });
}

function record(value: unknown): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error(`Expected record: ${JSON.stringify(value)}`);
	}
	return value as Record<string, unknown>;
}

function arrayProperty(value: Record<string, unknown>, key: string): unknown[] {
	const item = value[key];
	if (!Array.isArray(item)) throw new Error(`Expected ${key} array: ${JSON.stringify(value)}`);
	return item;
}

async function assertRejectsMcpCall(params: Record<string, unknown>, expected: string): Promise<void> {
	try {
		await requestGateway({ socketFile: server.socketFile, method: "mcp.call", params });
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (!message.includes(expected)) {
			throw new Error(`External MCP failure had unexpected message: ${message}`);
		}
		return;
	}
	throw new Error("External MCP call unexpectedly succeeded against failed server");
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
	const headers = new Headers({ Authorization: `Bearer ${token}` });
	if (options.body !== undefined) headers.set("content-type", "application/json");
	const request: RequestInit = { headers };
	if (options.method !== undefined) request.method = options.method;
	if (options.body !== undefined) request.body = JSON.stringify(options.body);
	const response = await fetch(url, request);
	if (!response.ok) throw new Error(`${url} returned ${response.status}: ${await response.text()}`);
	const value = (await response.json()) as unknown;
	return record(value);
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

function restoreEnv(key: string, value: string | undefined): void {
	if (value === undefined) {
		delete process.env[key];
	} else {
		process.env[key] = value;
	}
}
