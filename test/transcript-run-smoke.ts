import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(repo, "bin/clanky.ts");
const home = await mkdtemp(join(tmpdir(), "clanky-transcript-run-"));
const env = { ...process.env, CLANKY_HOME: home, HERDR_SESSION: "runner-smoke" };

try {
	const runner = await run(
		process.execPath,
		[
			cli,
			"transcript-run",
			"--agent",
			"clanky:runner",
			"--cwd",
			repo,
			"--run-id",
			"run-1",
			"--",
			"/bin/sh",
			"-c",
			'printf "early\\n"; printf "\\033[2J\\033[Hafter-clear\\n"; printf "last\\n"',
		],
		{ env, encoding: "utf8" },
	);
	if (!runner.stdout.includes("early") || !runner.stdout.includes("after-clear") || !runner.stdout.includes("last")) {
		throw new Error(`runner did not pass output through: ${JSON.stringify(runner.stdout)}`);
	}

	const read = await run(process.execPath, [cli, "transcript", "read", "clanky:runner", "--lines", "10"], {
		env,
		encoding: "utf8",
	});
	for (const expected of ["early", "after-clear", "last"]) {
		if (!read.stdout.includes(expected)) throw new Error(`transcript read missing ${expected}: ${JSON.stringify(read.stdout)}`);
	}
	if (read.stdout.includes("\u001b[")) throw new Error(`transcript read should be normalized: ${JSON.stringify(read.stdout)}`);

	const path = await run(process.execPath, [cli, "transcript", "path", "clanky:runner"], { env, encoding: "utf8" });
	if (!path.stdout.trim().endsWith(join("clanky:runner", "run-1"))) {
		throw new Error(`transcript path did not point at run: ${JSON.stringify(path.stdout)}`);
	}

	const metacharArg = "$(printf injected)";
	const argvFile = join(home, "script-argv.json");
	await writeFile(
		argvFile,
		`${JSON.stringify({
			argv: [process.execPath, "-e", "console.log(JSON.stringify(process.argv.slice(1)))", metacharArg],
		})}\n`,
	);
	const execRunner = await run(
		process.execPath,
		[cli, "transcript-exec", argvFile],
		{ env, encoding: "utf8" },
	);
	const execStdout = execRunner.stdout.replace(/\r/g, "");
	if (!execStdout.includes(JSON.stringify([metacharArg]))) {
		throw new Error(`transcript exec helper did not preserve shell metacharacters: ${JSON.stringify(execRunner.stdout)}`);
	}
	if (execStdout.includes(JSON.stringify(["injected"]))) {
		throw new Error(`transcript exec helper interpolated shell metacharacters: ${JSON.stringify(execRunner.stdout)}`);
	}
} finally {
	await rm(home, { recursive: true, force: true });
}

console.log("transcript-run-smoke: ok");
