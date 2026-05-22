import { spawn } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderSessionHtml, resolveClankyPaths } from "@clanky/core";

const homeDir = await mkdtemp(join(tmpdir(), "clanky-cli-"));
const help = await runClanky(["--help"]);
assertCommandSucceeded("top-level help", help);
assertIncludes(help.stdout, "Usage:");
for (const expected of [
	"clanky start",
	"clanky send",
	"clanky send [--profile <name>] [--home <path>] [--cwd <path>] [--http <host:port>]",
	"clanky session list",
	"clanky session resume",
	"clanky session fork",
	"clanky session search",
	"clanky session export",
	"clanky skill list|usage|add|remove",
	"clanky memory status|search|remember|forget|export|consent",
	"clanky task list|add|update",
	"clanky linear list|create|link|outbox|flush",
	"clanky swarm status|peers|tasks|snapshot|lock|message|complete|dispatch",
	"clanky profile list|new|use",
	"clanky install",
	"clanky uninstall",
	"clanky uninstall [--launchd | --systemd] [--profile <name>] [--home <path>]",
	"clanky mcp [config]",
	"clanky tui",
	"clanky cron list",
	"clanky cron add",
	"clanky cron rm|enable|disable|run-now",
	"clanky status",
	"clanky status [--profile <name>] [--home <path>] [--http <host:port>]",
	"clanky doctor",
	"clanky doctor [--profile <name>] [--home <path>] [--json]",
	"clanky stop",
	"--provider <provider>",
	"--model <model>",
	"--deliver stdout|file|session:<id>|swarm:<peer>|linear:<issue>",
	"--files <paths>",
	"--http [host:port]",
	"--bind [host:port]",
	"--enable",
]) {
	assertIncludes(help.stdout, expected);
}
const shortHelp = await runClanky(["-h"]);
assertCommandSucceeded("top-level short help", shortHelp);
assertIncludes(shortHelp.stdout, "Usage:");
assertIncludes(shortHelp.stdout, "clanky start");

const mcpConfig = await runClanky(["mcp", "config", "--home", homeDir]);
assertCommandSucceeded("mcp config", mcpConfig);
const parsedMcpConfig = JSON.parse(mcpConfig.stdout) as {
	mcpServers: Record<string, { command: string; args: string[]; cwd: string }>;
};
const defaultMcpServer = parsedMcpConfig.mcpServers.clanky;
if (defaultMcpServer === undefined) throw new Error(`MCP config did not include clanky server: ${mcpConfig.stdout}`);
if (defaultMcpServer.command !== "pnpm") throw new Error("MCP config should use pnpm");
if (defaultMcpServer.cwd !== process.cwd()) throw new Error(`MCP config cwd mismatch: ${defaultMcpServer.cwd}`);
if (JSON.stringify(defaultMcpServer.args) !== JSON.stringify(["--silent", "clanky", "mcp", "--home", homeDir])) {
	throw new Error(`MCP config args mismatch: ${JSON.stringify(defaultMcpServer.args)}`);
}

const profileMcpConfig = await runClanky(["mcp", "config", "--home", homeDir, "--profile", "work"]);
assertCommandSucceeded("profile mcp config", profileMcpConfig);
const parsedProfileMcpConfig = JSON.parse(profileMcpConfig.stdout) as {
	mcpServers: Record<string, { command: string; args: string[]; cwd: string }>;
};
const profileMcpServer = parsedProfileMcpConfig.mcpServers["clanky-work"];
if (profileMcpServer === undefined) {
	throw new Error(`Profile MCP config did not include clanky-work server: ${profileMcpConfig.stdout}`);
}
if (
	JSON.stringify(profileMcpServer.args) !==
	JSON.stringify(["--silent", "clanky", "mcp", "--home", homeDir, "--profile", "work"])
) {
	throw new Error(`Profile MCP config args mismatch: ${JSON.stringify(profileMcpServer.args)}`);
}

const tui = await runClanky(["tui", "--home", homeDir]);

if (tui.code === 0) {
	throw new Error(`Expected clanky tui without a daemon to fail\nstdout:\n${tui.stdout}\nstderr:\n${tui.stderr}`);
}
const visibleOutput = `${tui.stdout}\n${tui.stderr}`;
assertIncludes(visibleOutput, "Clanky daemon is not running. Start it with `clanky start` first.");
if (visibleOutput.includes("Start it now?")) {
	throw new Error("Noninteractive clanky tui should not prompt to start the daemon");
}
await verifyTuiPromptInPseudoTty(homeDir);

await verifyDetachedStart();
await verifyProfileDetachedStart();
await verifyForegroundSignalShutdown("SIGTERM");
await verifyForegroundSignalShutdown("SIGINT");

const initialProfiles = await runClanky(["profile", "list", "--home", homeDir]);
assertCommandSucceeded("profile list", initialProfiles);
assertIncludes(initialProfiles.stdout, "*\tdefault\t");

const newProfile = await runClanky(["profile", "new", "--home", homeDir, "work"]);
assertCommandSucceeded("profile new", newProfile);
assertIncludes(newProfile.stdout, "profile: work");

const activeProfile = await runClanky(["profile", "use", "--home", homeDir, "work"]);
assertCommandSucceeded("profile use", activeProfile);
assertIncludes(activeProfile.stdout, "active_profile: work");

const profiles = await runClanky(["profile", "list", "--home", homeDir]);
assertCommandSucceeded("profile list after use", profiles);
assertIncludes(profiles.stdout, " \tdefault\t");
assertIncludes(profiles.stdout, "*\twork\t");

const activeStatus = await runClanky(["status", "--home", homeDir]);
assertCommandSucceeded("active profile status", activeStatus);
assertIncludes(activeStatus.stdout, "running: false");
assertIncludes(activeStatus.stdout, "profile: work");
assertIncludes(activeStatus.stdout, `profile_dir: ${join(homeDir, "profiles", "work")}`);

const envStatus = await runClankyWithEnv(["status"], {
	...process.env,
	CLANKY_HOME: homeDir,
	CLANKY_PROFILE: "env-work",
});
assertCommandSucceeded("env status", envStatus);
assertIncludes(envStatus.stdout, "running: false");
assertIncludes(envStatus.stdout, "profile: env-work");
assertIncludes(envStatus.stdout, `home: ${homeDir}`);
assertIncludes(envStatus.stdout, `profile_dir: ${join(homeDir, "profiles", "env-work")}`);
assertIncludes(envStatus.stdout, `socket: ${join(homeDir, "profiles", "env-work", ".sock")}`);

const sessionId = "019e5f8f-8358-7c8d-9b42-3bd93600f1a0";
const timestamp = "2026-05-20T12:00:00.000Z";
const sessionContent = `${JSON.stringify({
	type: "session",
	version: 3,
	id: sessionId,
	timestamp,
	cwd: process.cwd(),
})}
${JSON.stringify({
	type: "message",
	id: "00000001",
	parentId: null,
	timestamp,
	message: {
		role: "user",
		content: "hello <clanky> & export",
		timestamp: Date.parse(timestamp),
	},
})}
`;
const sessionPaths = resolveClankyPaths({ homeDir, profile: "work" });
const sessionFile = join(sessionPaths.sessionsDir, `${timestamp}_${sessionId}.jsonl`);
await mkdir(sessionPaths.sessionsDir, { recursive: true, mode: 0o700 });
await writeFile(sessionFile, sessionContent, { mode: 0o600 });

const stdoutExport = await runClanky(["session", "export", "--home", homeDir, sessionId.slice(0, 8)]);
assertCommandSucceeded("session export stdout", stdoutExport);
assertIncludes(stdoutExport.stdout, "hello <clanky> & export");

const outputFile = join(homeDir, "session-export.jsonl");
const fileExport = await runClanky(["session", "export", "--home", homeDir, "--output", outputFile, sessionId]);
assertCommandSucceeded("session export output", fileExport);
assertIncludes(fileExport.stdout, `wrote: ${outputFile}`);
const exportedContent = await readFile(outputFile, "utf8");
if (exportedContent !== sessionContent) throw new Error("Session --output export did not preserve JSONL content");

const htmlFile = join(homeDir, "session-export.html");
const htmlExport = await runClanky(["session", "export", "--home", homeDir, "--html", htmlFile, sessionId]);
assertCommandSucceeded("session export html", htmlExport);
assertIncludes(htmlExport.stdout, `wrote: ${htmlFile}`);
const exportedHtml = await readFile(htmlFile, "utf8");
assertIncludes(exportedHtml, `Clanky Session ${sessionId}`);
assertIncludes(exportedHtml, "Estimated tokens");
assertIncludes(exportedHtml, "hello &lt;clanky&gt; &amp; export");
const workerHtml = await renderSessionHtml({ sessionId: "worker-smoke", content: "worker <escape> & check" });
assertIncludes(workerHtml, "Clanky Session worker-smoke");
assertIncludes(workerHtml, "<dt>Characters</dt><dd>23</dd>");
assertIncludes(workerHtml, "<dt>Words</dt><dd>4</dd>");
assertIncludes(workerHtml, "<dt>Estimated tokens</dt><dd>5</dd>");
assertIncludes(workerHtml, "worker &lt;escape&gt; &amp; check");
const pooledWorkerHtml = await Promise.all(
	["pool-a", "pool-b", "pool-c", "pool-d"].map((id) =>
		renderSessionHtml({ sessionId: id, content: `pooled <${id}> & check` }),
	),
);
for (const [index, html] of pooledWorkerHtml.entries()) {
	const id = `pool-${String.fromCharCode("a".charCodeAt(0) + index)}`;
	assertIncludes(html, `Clanky Session ${id}`);
	assertIncludes(html, "Estimated tokens");
	assertIncludes(html, `pooled &lt;${id}&gt; &amp; check`);
}

console.log(
	JSON.stringify({
		tuiExitCode: tui.code,
		helpBytes: help.stdout.length,
		shortHelpBytes: shortHelp.stdout.length,
		stderrBytes: tui.stderr.length,
		profileBytes: profiles.stdout.length,
		exportBytes: exportedContent.length,
		htmlBytes: exportedHtml.length,
		workerHtmlBytes: workerHtml.length,
		pooledWorkerHtml: pooledWorkerHtml.length,
		mcpConfigServers: Object.keys(parsedMcpConfig.mcpServers).length,
	}),
);
await rm(homeDir, { force: true, recursive: true });

async function verifyDetachedStart(): Promise<void> {
	const detachedHome = await mkdtemp(join(tmpdir(), "clanky-cli-detached-"));
	const bindAddress = `127.0.0.1:${await freePort()}`;
	let started = false;
	try {
		const start = await runClanky(["start", "--home", detachedHome, "--detach", "--bind", bindAddress]);
		assertCommandSucceeded("detached start", start);
		assertIncludes(start.stdout, "clanky daemon starting detached pid=");
		await waitFor(async () => {
			const status = await runClanky(["status", "--home", detachedHome]);
			if (!status.stdout.includes("running: true")) return false;
			assertIncludes(status.stdout, `home: ${detachedHome}`);
			const httpStatus = await runClanky(["status", "--home", detachedHome, "--http", bindAddress]);
			if (!httpStatus.stdout.includes("running: true")) return false;
			assertIncludes(httpStatus.stdout, `home: ${detachedHome}`);
			started = true;
			return true;
		}, "detached daemon status with --bind HTTP");
		const stop = await runClanky(["stop", "--home", detachedHome]);
		assertCommandSucceeded("detached stop", stop);
		assertIncludes(stop.stdout, "clanky daemon stopped");
		started = false;
		await waitFor(async () => {
			const status = await runClanky(["status", "--home", detachedHome]);
			return status.stdout.includes("running: false");
		}, "detached daemon stop");
	} finally {
		if (started) await runClanky(["stop", "--home", detachedHome]).catch(() => undefined);
		await rm(detachedHome, { force: true, recursive: true });
	}
}

async function verifyProfileDetachedStart(): Promise<void> {
	const detachedHome = await mkdtemp(join(tmpdir(), "clanky-cli-detached-profile-"));
	let started = false;
	try {
		const start = await runClanky(["start", "--home", detachedHome, "--profile", "work", "--detach"]);
		assertCommandSucceeded("profile detached start", start);
		assertIncludes(start.stdout, "clanky daemon starting detached pid=");
		await waitFor(async () => {
			const status = await runClanky(["status", "--home", detachedHome, "--profile", "work"]);
			if (!status.stdout.includes("running: true")) return false;
			assertIncludes(status.stdout, "profile: work");
			assertIncludes(status.stdout, `profile_dir: ${join(detachedHome, "profiles", "work")}`);
			started = true;
			return true;
		}, "profile detached daemon status");
		const defaultStatus = await runClanky(["status", "--home", detachedHome, "--profile", "default"]);
		assertCommandSucceeded("profile detached default status", defaultStatus);
		assertIncludes(defaultStatus.stdout, "running: false");
		assertIncludes(defaultStatus.stdout, "profile: default");
		const stop = await runClanky(["stop", "--home", detachedHome, "--profile", "work"]);
		assertCommandSucceeded("profile detached stop", stop);
		assertIncludes(stop.stdout, "clanky daemon stopped");
		started = false;
		await waitFor(async () => {
			const status = await runClanky(["status", "--home", detachedHome, "--profile", "work"]);
			return status.stdout.includes("running: false");
		}, "profile detached daemon stop");
	} finally {
		if (started) await runClanky(["stop", "--home", detachedHome, "--profile", "work"]).catch(() => undefined);
		await rm(detachedHome, { force: true, recursive: true });
	}
}

async function verifyForegroundSignalShutdown(signal: "SIGTERM" | "SIGINT"): Promise<void> {
	const signalHome = await mkdtemp(join(tmpdir(), `clanky-cli-${signal.toLowerCase()}-`));
	const paths = resolveClankyPaths({ homeDir: signalHome });
	const swarmCallsFile = join(signalHome, "swarm-calls.txt");
	const child = spawn(
		process.execPath,
		["--import", "tsx", "packages/clanky-cli/src/bin.ts", "start", "--home", signalHome],
		{
			cwd: process.cwd(),
			env: {
				...process.env,
				CLANKY_SWARM_ENABLED: "1",
				CLANKY_SWARM_COMMAND: process.execPath,
				CLANKY_SWARM_ARGS_JSON: JSON.stringify(["--import", "tsx", "packages/clanky-swarm/test/faux-swarm-mcp.ts"]),
				SWARM_HARNESS_FAUX_SWARM_CALLS_FILE: swarmCallsFile,
			},
			stdio: ["ignore", "pipe", "pipe"],
		},
	);
	let stdout = "";
	let stderr = "";
	let closed = false;
	child.stdout.on("data", (chunk) => {
		stdout += chunk.toString("utf8");
	});
	child.stderr.on("data", (chunk) => {
		stderr += chunk.toString("utf8");
	});
	try {
		await waitFor(async () => {
			const status = await runClanky(["status", "--home", signalHome]);
			return status.stdout.includes("running: true");
		}, "foreground daemon status");
		child.kill(signal);
		const result = await waitForChildClose(child, `foreground daemon ${signal}`, () => {
			closed = true;
		});
		if (result.code !== 0) {
			throw new Error(`Foreground daemon exited unexpectedly after ${signal}\nstdout:\n${stdout}\nstderr:\n${stderr}`);
		}
		await waitFor(async () => {
			const status = await runClanky(["status", "--home", signalHome]);
			return status.stdout.includes("running: false");
		}, "foreground daemon stopped status");
		if (await fileExists(paths.socketFile)) throw new Error(`Foreground ${signal} did not remove the daemon socket`);
		if (await fileExists(paths.daemonLockFile)) throw new Error(`Foreground ${signal} did not release the daemon lock`);
		const swarmCalls = await readFile(swarmCallsFile, "utf8");
		assertIncludes(swarmCalls, "deregister");
	} finally {
		if (!closed) child.kill("SIGTERM");
		await rm(signalHome, { force: true, recursive: true });
	}
}

async function verifyTuiPromptInPseudoTty(home: string): Promise<void> {
	const declined = await runClankyInPseudoTty(["tui", "--home", home], "n\n");
	if (declined.skipped) return;
	if (declined.code === 0) {
		throw new Error(
			`Expected TTY clanky tui without a daemon to fail after declining start\noutput:\n${declined.output}`,
		);
	}
	assertIncludes(declined.output, "Clanky daemon is not running. Start it now? [y/N]");
	assertIncludes(declined.output, "Clanky daemon is not running. Start it with `clanky start` first.");

	const acceptedHome = await mkdtemp(join(tmpdir(), "clanky-cli-tui-start-"));
	try {
		const accepted = await runClankyInPseudoTty(["tui", "--home", acceptedHome], "y\n", true);
		if (accepted.code !== 0) {
			throw new Error(
				`Expected TTY clanky tui to start a temporary daemon and exit cleanly\noutput:\n${accepted.output}`,
			);
		}
		assertIncludes(accepted.output, "Clanky daemon is not running. Start it now? [y/N]");
		assertIncludes(accepted.output, "Started temporary Clanky daemon on ");
		assertIncludes(accepted.output, "Clanky Dashboard");
	} finally {
		await rm(acceptedHome, { force: true, recursive: true });
	}
}

interface CommandResult {
	code: number | null;
	signal: NodeJS.Signals | null;
	stdout: string;
	stderr: string;
}

async function runClanky(args: string[]): Promise<CommandResult> {
	const child = spawn(process.execPath, ["--import", "tsx", "packages/clanky-cli/src/bin.ts", ...args], {
		cwd: process.cwd(),
		stdio: ["ignore", "pipe", "pipe"],
	});
	return await collectCommandResult(child, `clanky ${args.join(" ")}`);
}

async function runClankyWithEnv(args: string[], env: NodeJS.ProcessEnv): Promise<CommandResult> {
	const child = spawn(process.execPath, ["--import", "tsx", "packages/clanky-cli/src/bin.ts", ...args], {
		cwd: process.cwd(),
		env,
		stdio: ["ignore", "pipe", "pipe"],
	});
	return await collectCommandResult(child, `clanky ${args.join(" ")}`);
}

async function collectCommandResult(child: ReturnType<typeof spawn>, label: string): Promise<CommandResult> {
	let stdout = "";
	let stderr = "";
	if (!child.stdout || !child.stderr) throw new Error(`${label} did not create stdout/stderr pipes`);
	child.stdout.on("data", (chunk) => {
		stdout += chunk.toString("utf8");
	});
	child.stderr.on("data", (chunk) => {
		stderr += chunk.toString("utf8");
	});
	let timedOut = false;
	const timeout = setTimeout(() => {
		timedOut = true;
		child.kill("SIGTERM");
	}, 10_000);
	const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
		child.once("error", reject);
		child.once("close", (code, signal) => {
			resolve({ code, signal });
		});
	});
	clearTimeout(timeout);
	if (timedOut) {
		throw new Error(`${label} timed out\nstdout:\n${stdout}\nstderr:\n${stderr}`);
	}
	return { ...result, stdout, stderr };
}

interface PseudoTtyResult {
	code: number | null;
	output: string;
	skipped: boolean;
}

async function runClankyInPseudoTty(
	args: string[],
	input: string,
	quitAfterDashboard = false,
): Promise<PseudoTtyResult> {
	const command = [process.execPath, "--import", "tsx", "packages/clanky-cli/src/bin.ts", ...args];
	const scriptLines = [
		"set timeout 15",
		`spawn ${command.map(tclWord).join(" ")}`,
		'expect "Clanky daemon is not running. Start it now? \\[y/N\\]"',
		`send ${tclWord(input.replaceAll("\n", "\r"))}`,
	];
	if (quitAfterDashboard) {
		scriptLines.push('expect "Clanky Dashboard"', "after 1000", `send ${tclWord("q")}`);
	}
	scriptLines.push("expect eof", "catch wait result", "set exitCode [lindex $result 3]", "exit $exitCode");
	const script = scriptLines.join("\n");
	const child = spawn("expect", ["-c", script]);
	let output = "";
	child.stdout.on("data", (chunk) => {
		output += chunk.toString("utf8");
	});
	child.stderr.on("data", (chunk) => {
		output += chunk.toString("utf8");
	});
	child.stdin.write(input);
	child.stdin.end();
	let timedOut = false;
	const timeout = setTimeout(() => {
		timedOut = true;
		child.kill("SIGTERM");
	}, 20_000);
	const result = await new Promise<{ code: number | null; skipped: boolean }>((resolve, reject) => {
		child.once("error", (error: NodeJS.ErrnoException) => {
			if (error.code === "ENOENT") {
				resolve({ code: null, skipped: true });
				return;
			}
			reject(error);
		});
		child.once("close", (code) => {
			resolve({ code, skipped: false });
		});
	});
	clearTimeout(timeout);
	if (timedOut) {
		throw new Error(`pseudo-TTY clanky ${args.join(" ")} timed out\noutput:\n${output}`);
	}
	return { ...result, output };
}

async function waitForChildClose(
	child: ReturnType<typeof spawn>,
	label: string,
	onClose: () => void,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
	let timedOut = false;
	const timeout = setTimeout(() => {
		timedOut = true;
		child.kill("SIGTERM");
	}, 10_000);
	const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
		child.once("error", reject);
		child.once("close", (code, signal) => {
			onClose();
			resolve({ code, signal });
		});
	});
	clearTimeout(timeout);
	if (timedOut) throw new Error(`${label} timed out`);
	return result;
}

async function fileExists(file: string): Promise<boolean> {
	return await access(file)
		.then(() => true)
		.catch(() => false);
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

function tclWord(value: string): string {
	return `{${value.replaceAll("\\", "\\\\").replaceAll("}", "\\}")}}`;
}

function assertIncludes(value: string, expected: string): void {
	if (!value.includes(expected)) throw new Error(`Missing expected output: ${expected}\nActual:\n${value}`);
}

function assertCommandSucceeded(label: string, result: CommandResult): void {
	if (result.code === 0) return;
	throw new Error(`${label} failed with ${result.code}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
}

async function waitFor(predicate: () => Promise<boolean>, label: string): Promise<void> {
	const deadline = Date.now() + 10_000;
	let lastError: unknown;
	while (Date.now() < deadline) {
		try {
			if (await predicate()) return;
		} catch (error) {
			lastError = error;
		}
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	const suffix = lastError instanceof Error ? `: ${lastError.message}` : "";
	throw new Error(`Timed out waiting for ${label}${suffix}`);
}
