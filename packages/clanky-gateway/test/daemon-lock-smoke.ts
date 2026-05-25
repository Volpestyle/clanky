import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { resolveClankyPaths } from "@clanky/core";
import { type GatewayServer, startGatewayServer } from "@clanky/gateway";

const execFileAsync = promisify(execFile);

const homeDir = await mkdtemp(join(tmpdir(), "clanky-daemon-lock-"));
const paths = resolveClankyPaths({ homeDir });
const previousExternalMcpConfig = process.env.CLANKY_MCP_SERVERS_JSON;

await mkdir(dirname(paths.daemonLockFile), { recursive: true, mode: 0o700 });

// Case 1 (live lock): a real running daemon holds the lock. Use the actual
// process start time of the current node test runner so it matches.
const currentProcessStartedAt = await readProcessStartTime(process.pid);
if (currentProcessStartedAt === undefined) {
	throw new Error("Daemon-lock smoke test requires `ps -o lstart=` to be available on this platform");
}
await writeLockJson(paths.daemonLockFile, {
	pid: process.pid,
	startedAt: currentProcessStartedAt,
	bootId: "live-test-boot",
});

const externalMcpMarker = join(homeDir, "external-mcp-started");
const externalMcpScript = join(homeDir, "external-mcp-marker.mjs");
await writeFile(
	externalMcpScript,
	['import { writeFileSync } from "node:fs";', 'writeFileSync(process.argv[2], "started\\n", { mode: 0o600 });'].join(
		"\n",
	),
	{ mode: 0o600 },
);
process.env.CLANKY_MCP_SERVERS_JSON = JSON.stringify([
	{
		name: "lock-marker",
		command: process.execPath,
		args: [externalMcpScript, externalMcpMarker],
	},
]);

let liveLockError: string | undefined;
try {
	liveLockError = await startGatewayServer({ homeDir })
		.then(async (server) => {
			await server.close();
			return undefined;
		})
		.catch((error: unknown) => (error instanceof Error ? error.message : String(error)));
} finally {
	restoreEnv("CLANKY_MCP_SERVERS_JSON", previousExternalMcpConfig);
}

if (liveLockError === undefined || !liveLockError.includes(`pid ${process.pid}`)) {
	throw new Error(`Expected a live daemon lock to block startup, got: ${liveLockError ?? "no error"}`);
}
if (await fileExists(externalMcpMarker)) {
	throw new Error("Live daemon lock should block startup before external MCP subprocesses are spawned");
}

// Case 2 (stale dead PID): unused PID, lock should be reclaimed.
const stalePid = findUnusedPid();
await writeLockJson(paths.daemonLockFile, { pid: stalePid, startedAt: Date.now(), bootId: "stale-test-boot" });
const server = await startGatewayServer({ homeDir });
await server.close();

await readFile(paths.daemonLockFile, "utf8").then(
	() => {
		throw new Error("Daemon lock should be released after gateway shutdown");
	},
	() => undefined,
);

// Case 3 (recycled PID): current pid is alive, but lock's startedAt is from
// long ago — the lock must be detected as a recycled-PID stale lock.
await writeLockJson(paths.daemonLockFile, {
	pid: process.pid,
	startedAt: 1_000_000_000_000,
	bootId: "recycled-test-boot",
});
const recycledServer = await startGatewayServer({ homeDir });
await recycledServer.close();

// Case 4 (empty lock file): empty content should be treated as stale.
await writeFile(paths.daemonLockFile, "", { mode: 0o600 });
const emptyServer = await startGatewayServer({ homeDir });
await emptyServer.close();

// Case 5 (malformed JSON): garbage content should be treated as stale.
await writeFile(paths.daemonLockFile, "not-valid-json{{{", { mode: 0o600 });
const malformedServer = await startGatewayServer({ homeDir });
await malformedServer.close();

// Case 6 (concurrent stale reclaim): existing race-safety contract.
const racingStalePid = findUnusedPid();
await writeLockJson(paths.daemonLockFile, { pid: racingStalePid, startedAt: Date.now(), bootId: "race-test-boot" });
const racingStarts = await Promise.allSettled(Array.from({ length: 6 }, () => startGatewayServer({ homeDir })));
const startedServers = racingStarts
	.filter((result): result is PromiseFulfilledResult<GatewayServer> => result.status === "fulfilled")
	.map((result) => result.value);
try {
	if (startedServers.length !== 1) {
		throw new Error(`Concurrent stale daemon lock reclaim should start exactly one server: ${startedServers.length}`);
	}
	const rejectedStarts = racingStarts.filter((result): result is PromiseRejectedResult => result.status === "rejected");
	if (rejectedStarts.length !== 5) {
		throw new Error(`Concurrent stale daemon lock reclaim should reject five contenders: ${rejectedStarts.length}`);
	}
	for (const rejected of rejectedStarts) {
		const message = errorMessage(rejected.reason);
		if (message.includes("EEXIST")) throw new Error(`Daemon lock race leaked raw EEXIST: ${message}`);
		const isExpectedDaemonRunning = message.includes(`pid ${process.pid}`);
		const isExpectedLockClaimed = message.includes("Clanky daemon lock was claimed by another process");
		const isExpectedSocketBusy = message.includes("EADDRINUSE");
		if (!isExpectedDaemonRunning && !isExpectedLockClaimed && !isExpectedSocketBusy) {
			throw new Error(`Daemon lock race returned unexpected error: ${message}`);
		}
	}
} finally {
	for (const started of startedServers) await started.close();
}

await readFile(paths.daemonLockFile, "utf8").then(
	() => {
		throw new Error("Daemon lock should be released after concurrent gateway shutdown");
	},
	() => undefined,
);

console.log(JSON.stringify({ stalePid, racingStalePid, recovered: true }));
await rm(homeDir, { force: true, recursive: true });

function findUnusedPid(): number {
	for (let pid = 999_999; pid > 100_000; pid -= 1) {
		try {
			process.kill(pid, 0);
		} catch {
			return pid;
		}
	}
	throw new Error("Could not find an unused PID for daemon lock smoke test");
}

async function readProcessStartTime(pid: number): Promise<number | undefined> {
	try {
		const { stdout } = await execFileAsync("ps", ["-o", "lstart=", "-p", String(pid)]);
		const trimmed = stdout.trim();
		if (trimmed.length === 0) return undefined;
		const parsed = Date.parse(trimmed);
		return Number.isFinite(parsed) ? parsed : undefined;
	} catch {
		return undefined;
	}
}

async function writeLockJson(file: string, record: { pid: number; startedAt: number; bootId: string }): Promise<void> {
	await writeFile(file, `${JSON.stringify(record)}\n`, { mode: 0o600 });
}

async function fileExists(file: string): Promise<boolean> {
	return await access(file)
		.then(() => true)
		.catch(() => false);
}

function restoreEnv(key: "CLANKY_MCP_SERVERS_JSON", value: string | undefined): void {
	if (value === undefined) {
		delete process.env[key];
		return;
	}
	process.env[key] = value;
}

function errorMessage(value: unknown): string {
	return value instanceof Error ? value.message : String(value);
}
