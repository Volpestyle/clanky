import { spawn } from "node:child_process";
import { access, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

const homeDir = await mkdtemp(join(tmpdir(), "clanky-install-"));
const previousSwarmArgs = process.env.CLANKY_SWARM_ARGS_JSON;
process.env.CLANKY_SWARM_ARGS_JSON = JSON.stringify(["/tmp/swarm-mcp.js"]);

const installEnvArgs = [
	"--env",
	"CLANKY_SWARM_ENABLED=1",
	"--env",
	"CLANKY_SWARM_COMMAND=node",
	"--env-from-current",
	"CLANKY_SWARM_ARGS_JSON",
];

let launchd: CommandResult;
let systemd: CommandResult;
let profileLaunchd: CommandResult;
let profileSystemd: CommandResult;
try {
	launchd = await runClanky(["install", "--launchd", "--home", homeDir, ...installEnvArgs, "--print"]);
	systemd = await runClanky(["install", "--systemd", "--home", homeDir, ...installEnvArgs, "--print"]);
	profileLaunchd = await runClanky([
		"install",
		"--launchd",
		"--home",
		homeDir,
		"--profile",
		"work",
		...installEnvArgs,
		"--print",
	]);
	profileSystemd = await runClanky([
		"install",
		"--systemd",
		"--home",
		homeDir,
		"--profile",
		"work",
		...installEnvArgs,
		"--print",
	]);
} finally {
	if (previousSwarmArgs === undefined) {
		delete process.env.CLANKY_SWARM_ARGS_JSON;
	} else {
		process.env.CLANKY_SWARM_ARGS_JSON = previousSwarmArgs;
	}
}

assertIncludes(launchd.stdout, "<key>RunAtLoad</key>", "launchd plist should run at load");
assertIncludes(launchd.stdout, "<string>com.clanky.daemon</string>", "default launchd label should be stable");
assertIncludes(launchd.stdout, "<string>clanky</string>", "launchd plist should invoke clanky");
assertIncludes(launchd.stdout, "<string>start</string>", "launchd plist should start the daemon");
assertIncludes(launchd.stdout, "<string>--home</string>", "launchd plist should pass --home");
assertIncludes(launchd.stdout, "<key>KeepAlive</key>", "launchd plist should include KeepAlive");
assertIncludes(launchd.stdout, "<key>SuccessfulExit</key>", "launchd plist should gate restart on failed exits");
assertIncludes(launchd.stdout, "<false/>", "launchd plist should not restart successful exits");
assertIncludes(launchd.stdout, "<key>CLANKY_SWARM_ENABLED</key>", "launchd plist should include service env");
assertIncludes(launchd.stdout, "<string>1</string>", "launchd plist should include service env values");
assertIncludes(launchd.stdout, "<key>CLANKY_HOME</key>", "launchd plist should include CLANKY_HOME");
assertIncludes(launchd.stdout, `<string>${homeDir}</string>`, "launchd plist should include the requested home");
assertIncludes(launchd.stdout, "clanky.out.log", "default launchd plist should use the default stdout log");
assertIncludes(launchd.stdout, "clanky.err.log", "default launchd plist should use the default stderr log");
assertIncludes(
	launchd.stdout,
	"<key>CLANKY_SWARM_ARGS_JSON</key>",
	"launchd plist should include env copied from current process",
);
assertNoLiveGateCredentialEnv(launchd.stdout, "launchd print");
assertIncludes(systemd.stdout, "Restart=on-failure", "systemd unit should restart failed exits");
assertIncludes(systemd.stdout, "WantedBy=default.target", "systemd unit should install into the user target");
assertIncludes(systemd.stdout, "clanky start --home", "systemd unit should start the daemon through clanky");
assertIncludes(systemd.stdout, `Environment=CLANKY_HOME=${homeDir}`, "systemd unit should include CLANKY_HOME");
assertIncludes(systemd.stdout, "Environment=CLANKY_SWARM_ENABLED=1", "systemd unit should include service env");
assertIncludes(systemd.stdout, "CLANKY_SWARM_ARGS_JSON", "systemd unit should include env copied from current process");
assertIncludes(systemd.stdout, "/tmp/swarm-mcp.js", "systemd unit should include copied env value");
assertNoLiveGateCredentialEnv(systemd.stdout, "systemd print");
assertIncludes(
	profileLaunchd.stdout,
	"<string>com.clanky.daemon.work</string>",
	"profile launchd label should avoid service collisions",
);
assertIncludes(
	profileLaunchd.stdout,
	"<key>CLANKY_PROFILE</key>",
	"profile launchd plist should include CLANKY_PROFILE",
);
assertIncludes(profileLaunchd.stdout, "<string>--profile</string>", "profile launchd plist should pass --profile");
assertIncludes(profileLaunchd.stdout, "<string>work</string>", "profile launchd plist should include profile value");
assertIncludes(
	profileLaunchd.stdout,
	"clanky.work.out.log",
	"profile launchd plist should use a profile-specific stdout log",
);
assertIncludes(
	profileLaunchd.stdout,
	"clanky.work.err.log",
	"profile launchd plist should use a profile-specific stderr log",
);
assertNotIncludes(
	profileLaunchd.stdout,
	`${homeDir}/clanky.out.log`,
	"profile launchd plist should not share the default stdout log",
);
assertNoLiveGateCredentialEnv(profileLaunchd.stdout, "profile launchd print");
assertIncludes(
	profileSystemd.stdout,
	"Environment=CLANKY_PROFILE=work",
	"profile systemd unit should include CLANKY_PROFILE",
);
assertIncludes(profileSystemd.stdout, "--profile work", "profile systemd unit should pass --profile");
assertNoLiveGateCredentialEnv(profileSystemd.stdout, "profile systemd print");

const reservedEnv = await runClankyAllowFailure([
	"install",
	"--launchd",
	"--home",
	homeDir,
	"--env",
	"CLANKY_HOME=/tmp/clanky",
	"--print",
]);
assertCommandFailed("reserved CLANKY_HOME env", reservedEnv);
assertIncludes(reservedEnv.stderr, "Use --home instead of --env CLANKY_HOME=...", "reserved env should be rejected");

const missingEnv = await runClankyAllowFailure([
	"install",
	"--launchd",
	"--home",
	homeDir,
	"--env-from-current",
	"CLANKY_INSTALL_SMOKE_MISSING",
	"--print",
]);
assertCommandFailed("missing env-from-current", missingEnv);
assertIncludes(
	missingEnv.stderr,
	"Environment variable CLANKY_INSTALL_SMOKE_MISSING is not set",
	"missing env-from-current should be rejected",
);

const installRoot = await mkdtemp(join(tmpdir(), "clanky-install-write-"));
const missingHomeDir = join(installRoot, "missing-home");
const plistOutput = join(installRoot, "launch-agents", "com.clanky.daemon.plist");
const launchdWrite = await runClanky(["install", "--launchd", "--home", missingHomeDir, "--output", plistOutput]);
assertIncludes(launchdWrite.stdout, `wrote: ${plistOutput}`, "launchd install should write output path");
const homeStat = await stat(missingHomeDir);
if (!homeStat.isDirectory()) throw new Error("launchd install did not create the Clanky home directory");
await lintPlist(plistOutput);

const profileInstallRoot = await mkdtemp(join(tmpdir(), "clanky-profile-install-"));
const profilePlistOutput = join(profileInstallRoot, "launch-agents", "com.clanky.daemon.work.plist");
const profileInstall = await runClanky([
	"install",
	"--launchd",
	"--home",
	profileInstallRoot,
	"--profile",
	"work",
	"--output",
	profilePlistOutput,
]);
assertIncludes(
	profileInstall.stdout,
	`wrote: ${profilePlistOutput}`,
	"profile launchd install should write the requested profile-specific plist path",
);
assertIncludes(
	profileInstall.stdout,
	"gui/",
	"profile launchd install should print launchctl commands for the profile service",
);
assertIncludes(
	profileInstall.stdout,
	"com.clanky.daemon.work",
	"profile launchd install should print profile-specific launchctl label",
);
await lintPlist(profilePlistOutput);

const defaultHttpInstall = await runClanky(["install", "--launchd", "--home", homeDir, "--http", "--print"]);
assertIncludes(defaultHttpInstall.stdout, "<string>--http</string>", "bare --http should add the HTTP flag");
assertIncludes(
	defaultHttpInstall.stdout,
	"<string>127.0.0.1:7766</string>",
	"bare --http should use the default local address",
);
const profileHttpInstall = await runClanky([
	"install",
	"--launchd",
	"--home",
	homeDir,
	"--http",
	"--profile",
	"work",
	"--print",
]);
assertIncludes(profileHttpInstall.stdout, "<string>--http</string>", "profile bare --http should add the HTTP flag");
assertIncludes(profileHttpInstall.stdout, "<string>127.0.0.1:", "profile bare --http should use a local address");
assertNotIncludes(
	profileHttpInstall.stdout,
	"<string>127.0.0.1:7766</string>",
	"profile bare --http should avoid the default profile port",
);
const personalHttpInstall = await runClanky([
	"install",
	"--launchd",
	"--home",
	homeDir,
	"--profile",
	"personal",
	"--http",
	"--print",
]);
const workHttpAddress = extractLocalHttpAddress(profileHttpInstall.stdout);
const personalHttpAddress = extractLocalHttpAddress(personalHttpInstall.stdout);
if (workHttpAddress === personalHttpAddress) {
	throw new Error(`Profile HTTP ports should differ: ${workHttpAddress}`);
}

const npmExecpathInstall = await runClankyWithEnv(["install", "--launchd", "--home", homeDir, "--print"], {
	npm_execpath: "/tmp/npm-cli.js",
});
const pnpmExecutable = await findExecutable("pnpm");
if (pnpmExecutable === undefined) throw new Error("pnpm executable was not found on PATH");
assertIncludes(
	npmExecpathInstall.stdout,
	`<string>${pnpmExecutable}</string>`,
	"service command should fall back to an absolute pnpm path when npm_execpath is not pnpm",
);
assertNotIncludes(
	npmExecpathInstall.stdout,
	"npm-cli.js",
	"service command should not preserve an npm executable path",
);

const previousPort = process.env.CLANKY_PORT;
process.env.CLANKY_PORT = "8877";
try {
	const envPortInstall = await runClanky(["install", "--systemd", "--home", homeDir, "--http", "--print"]);
	assertIncludes(
		envPortInstall.stdout,
		"--http 127.0.0.1:8877",
		"bare --http should honor CLANKY_PORT in systemd command",
	);
	const envProfilePortInstall = await runClanky([
		"install",
		"--systemd",
		"--home",
		homeDir,
		"--profile",
		"work",
		"--http",
		"--print",
	]);
	assertIncludes(
		envProfilePortInstall.stdout,
		"--http 127.0.0.1:8877",
		"profile bare --http should honor CLANKY_PORT when it is set",
	);
} finally {
	if (previousPort === undefined) {
		delete process.env.CLANKY_PORT;
	} else {
		process.env.CLANKY_PORT = previousPort;
	}
}

const launchdUninstall = await runClanky(["uninstall", "--launchd", "--home", homeDir, "--profile", "work", "--print"]);
assertIncludes(launchdUninstall.stdout, "launchctl bootout gui/", "launchd uninstall should print the bootout command");
assertIncludes(
	launchdUninstall.stdout,
	"com.clanky.daemon.work",
	"launchd uninstall should use the profile-specific label",
);
assertIncludes(
	launchdUninstall.stdout,
	"com.clanky.daemon.work.plist",
	"launchd uninstall should print the profile-specific plist path",
);

const systemdUninstall = await runClanky(["uninstall", "--systemd", "--home", homeDir, "--profile", "work", "--print"]);
assertIncludes(
	systemdUninstall.stdout,
	"systemctl --user disable --now clanky-work.service",
	"systemd uninstall should print the profile-specific disable command",
);
assertIncludes(systemdUninstall.stdout, "systemctl --user daemon-reload", "systemd uninstall should reload systemd");
await Promise.all([homeDir, installRoot, profileInstallRoot].map((dir) => rm(dir, { force: true, recursive: true })));

console.log(JSON.stringify({ launchdBytes: launchd.stdout.length, systemdBytes: systemd.stdout.length }));

interface CommandResult {
	code: number | null;
	stdout: string;
	stderr: string;
}

async function runClanky(args: string[]): Promise<CommandResult> {
	const result = await runClankyAllowFailure(args);
	if (result.code !== 0) {
		throw new Error(
			`clanky ${args.join(" ")} exited with ${result.code}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
		);
	}
	return result;
}

async function runClankyAllowFailure(args: string[]): Promise<CommandResult> {
	return await runClankyProcess("pnpm", ["--silent", "tsx", "packages/clanky-cli/src/bin.ts", ...args], process.env);
}

async function runClankyWithEnv(args: string[], env: NodeJS.ProcessEnv): Promise<CommandResult> {
	const result = await runClankyProcess(
		process.execPath,
		["--import", "tsx", "packages/clanky-cli/src/bin.ts", ...args],
		{ ...process.env, ...env },
	);
	if (result.code !== 0) {
		throw new Error(
			`clanky ${args.join(" ")} exited with ${result.code}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
		);
	}
	return result;
}

async function runClankyProcess(command: string, args: string[], env: NodeJS.ProcessEnv): Promise<CommandResult> {
	const child = spawn(command, args, {
		cwd: process.cwd(),
		stdio: ["ignore", "pipe", "pipe"],
		env,
	});
	let stdout = "";
	let stderr = "";
	child.stdout.on("data", (chunk) => {
		stdout += chunk.toString("utf8");
	});
	child.stderr.on("data", (chunk) => {
		stderr += chunk.toString("utf8");
	});
	const code = await new Promise<number | null>((resolve, reject) => {
		child.once("error", reject);
		child.once("close", resolve);
	});
	return { code, stdout, stderr };
}

async function lintPlist(path: string): Promise<void> {
	try {
		await access("/usr/bin/plutil");
	} catch {
		return;
	}
	const result = await runClankyProcess("/usr/bin/plutil", ["-lint", path], process.env);
	if (result.code !== 0) {
		throw new Error(`plutil failed for ${path}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
	}
}

function assertIncludes(value: string, expected: string, message: string): void {
	if (!value.includes(expected)) throw new Error(`${message}: missing ${expected}`);
}

function assertNotIncludes(value: string, unexpected: string, message: string): void {
	if (value.includes(unexpected)) throw new Error(`${message}: found ${unexpected}`);
}

function assertNoLiveGateCredentialEnv(value: string, label: string): void {
	for (const key of ["LINEAR_API_KEY", "LINEAR_ACCESS_TOKEN", "OPENAI_API_KEY", "ANTHROPIC_API_KEY"]) {
		assertNotIncludes(value, key, `${label} should not print live-gate credential env names`);
	}
}

function assertCommandFailed(label: string, result: CommandResult): void {
	if (result.code !== 0) return;
	throw new Error(`${label} unexpectedly succeeded\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
}

function extractLocalHttpAddress(value: string): string {
	const match = value.match(/127\.0\.0\.1:\d+/);
	if (match === null) throw new Error(`No local HTTP address found in output:\n${value}`);
	return match[0];
}

async function findExecutable(command: string): Promise<string | undefined> {
	const path = process.env.PATH ?? "";
	for (const directory of path.split(delimiter)) {
		if (directory.length === 0) continue;
		const candidate = join(directory, command);
		try {
			await access(candidate);
			return candidate;
		} catch {}
	}
	return undefined;
}
