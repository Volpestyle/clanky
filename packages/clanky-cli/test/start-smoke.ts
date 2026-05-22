import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const homeDir = await mkdtemp(join(tmpdir(), "clanky-start-"));
try {
	const start = await runClanky(["start", "--home", homeDir, "--once"]);
	assertCommandSucceeded("start --once", start);
	assertIncludes(start.stdout, "clanky daemon smoke booted");
	assertIncludes(start.stdout, "session:");
	assertIncludes(start.stdout, "session_file:");

	console.log(
		JSON.stringify({
			stdoutBytes: start.stdout.length,
			homeDir,
		}),
	);
} finally {
	await rm(homeDir, { force: true, recursive: true });
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
	let stdout = "";
	let stderr = "";
	child.stdout.on("data", (chunk) => {
		stdout += chunk.toString("utf8");
	});
	child.stderr.on("data", (chunk) => {
		stderr += chunk.toString("utf8");
	});
	const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
		child.once("error", reject);
		child.once("close", (code, signal) => {
			resolve({ code, signal });
		});
	});
	return { ...result, stdout, stderr };
}

function assertCommandSucceeded(label: string, result: CommandResult): void {
	if (result.code === 0) return;
	throw new Error(`${label} failed with ${result.code}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
}

function assertIncludes(value: string, expected: string): void {
	if (!value.includes(expected)) throw new Error(`Missing expected output: ${expected}\nActual:\n${value}`);
}
