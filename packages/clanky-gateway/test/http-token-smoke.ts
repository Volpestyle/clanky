import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startGatewayServer } from "@clanky/gateway";

const homeDir = await mkdtemp(join(tmpdir(), "clanky-http-token-"));
const firstPort = await freePort();
const firstServer = await startGatewayServer({ homeDir, http: { hostname: "127.0.0.1", port: firstPort } });

let firstToken = "";
try {
	firstToken = (await readFile(firstServer.registry.paths.httpTokenFile, "utf8")).trim();
	if (firstToken.length === 0) throw new Error("Initial HTTP token was empty");
	assertHttpTokenShape(firstToken, "initial HTTP token");
	await assertFileMode(firstServer.registry.paths.httpTokenFile, 0o600, "initial HTTP token");
	const baseUrl = `http://127.0.0.1:${firstPort}`;

	assertStatus(await fetch(`${baseUrl}/status`), 401, "missing auth");
	assertStatus(
		await fetch(`${baseUrl}/status`, { headers: { Authorization: `Bearer ${firstToken}x` } }),
		401,
		"invalid bearer token",
	);
	assertStatus(
		await fetch(`${baseUrl}/status`, { headers: { "X-Clanky-Token": `${firstToken}x` } }),
		401,
		"invalid X-Clanky-Token",
	);
	assertStatus(
		await fetch(`${baseUrl}/status?token=${encodeURIComponent(`${firstToken}x`)}`),
		401,
		"invalid query token",
	);

	const headerAuth = await fetch(`${baseUrl}/status`, { headers: { "X-Clanky-Token": firstToken } });
	if (!headerAuth.ok) throw new Error(`X-Clanky-Token auth failed with ${headerAuth.status}`);
	const headerStatus = await headerAuth.text();
	assertNotIncludes(headerStatus, firstToken, "status response must not leak initial HTTP token");

	const queryAuth = await fetch(`${baseUrl}/status?token=${encodeURIComponent(firstToken)}`);
	if (!queryAuth.ok) throw new Error(`query token auth failed with ${queryAuth.status}`);
	const queryStatus = await queryAuth.text();
	assertNotIncludes(queryStatus, firstToken, "query-auth status response must not leak initial HTTP token");
} finally {
	await firstServer.close();
}

const secondPort = await freePort();
const secondServer = await startGatewayServer({
	homeDir,
	http: { hostname: "127.0.0.1", port: secondPort },
	newHttpToken: true,
});
let secondToken = "";

try {
	secondToken = (await readFile(secondServer.registry.paths.httpTokenFile, "utf8")).trim();
	if (secondToken.length === 0) throw new Error("Rotated HTTP token was empty");
	assertHttpTokenShape(secondToken, "rotated HTTP token");
	if (secondToken === firstToken) throw new Error("HTTP token rotation reused the previous token");
	await assertFileMode(secondServer.registry.paths.httpTokenFile, 0o600, "rotated HTTP token");
	const baseUrl = `http://127.0.0.1:${secondPort}`;

	const oldToken = await fetch(`${baseUrl}/status`, { headers: { Authorization: `Bearer ${firstToken}` } });
	if (oldToken.status !== 401) throw new Error(`Old token should be rejected after rotation, got ${oldToken.status}`);

	const newToken = await fetch(`${baseUrl}/status`, { headers: { Authorization: `Bearer ${secondToken}` } });
	if (!newToken.ok) throw new Error(`Rotated token auth failed with ${newToken.status}`);
	const rotatedStatus = await newToken.text();
	assertNotIncludes(rotatedStatus, secondToken, "status response must not leak rotated HTTP token");
} finally {
	await secondServer.close();
}

const publicBindPort = await freePort();
const publicBindServer = await startGatewayServer({
	homeDir,
	http: { hostname: "0.0.0.0", port: publicBindPort },
});

try {
	const baseUrl = `http://127.0.0.1:${publicBindPort}`;
	assertStatus(await fetch(`${baseUrl}/status`), 401, "public bind missing auth");
	const authorized = await fetch(`${baseUrl}/status`, { headers: { Authorization: `Bearer ${secondToken}` } });
	if (!authorized.ok) throw new Error(`public bind bearer auth failed with ${authorized.status}`);
	const publicBindStatus = await authorized.text();
	assertNotIncludes(publicBindStatus, secondToken, "public bind status response must not leak HTTP token");

	console.log(JSON.stringify({ firstPort, secondPort, publicBindPort, rotated: secondToken !== firstToken }));
} finally {
	await publicBindServer.close();
	await rm(homeDir, { force: true, recursive: true });
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

function assertStatus(response: Response, expected: number, label: string): void {
	if (response.status !== expected) {
		throw new Error(`${label} should return ${expected}, got ${response.status}`);
	}
}

function assertHttpTokenShape(token: string, label: string): void {
	if (!/^[0-9a-f]{64}$/.test(token)) {
		throw new Error(`${label} should be 32 random bytes encoded as 64 lowercase hex chars`);
	}
}

function assertNotIncludes(value: string, unexpected: string, label: string): void {
	if (value.includes(unexpected)) throw new Error(label);
}

async function assertFileMode(path: string, expectedMode: number, label: string): Promise<void> {
	const actualMode = (await stat(path)).mode & 0o777;
	if (actualMode !== expectedMode) {
		throw new Error(`${label} file mode should be ${expectedMode.toString(8)}, got ${actualMode.toString(8)}`);
	}
}
