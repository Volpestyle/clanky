#!/usr/bin/env node
import { spawn } from "node:child_process";
import { watch } from "node:fs";
import { lstat, mkdir, readlink, rm, symlink } from "node:fs/promises";
import { readFile, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "eve/client";
import { serializeCommandLine } from "../agent/lib/coding-harness.ts";
import {
	appendTranscriptChunk,
	createTranscriptRun,
	finishTranscriptRun,
	latestTranscriptRun,
	listTranscriptRuns,
	newTranscriptRunId,
	readTranscript,
} from "../agent/lib/transcripts.ts";

const CLI_PATH = fileURLToPath(import.meta.url);
const REPO = resolve(dirname(CLI_PATH), "..");
const INSTALL_DIR = join(process.env.HOME ?? "", ".local/bin");
const INSTALL_PATH = join(INSTALL_DIR, "clanky");

type CommandResult = {
	code: number;
};

type EveEvent = {
	type: string;
	data?: unknown;
};

const args = process.argv.slice(2);
const command = args[0] ?? "face";
const rest = args.slice(1);

function resolvePort(value: string | undefined, fallback: number): number {
	const raw = value?.trim();
	if (raw === undefined || raw.length === 0) return fallback;
	const parsed = Number.parseInt(raw, 10);
	if (!Number.isInteger(parsed) || String(parsed) !== raw || parsed < 1 || parsed > 65_535) {
		throw new Error(`CLANKY_EVE_PORT must be an integer from 1 to 65535; got ${JSON.stringify(value)}`);
	}
	return parsed;
}

try {
	resolvePort(process.env.CLANKY_EVE_PORT, 2000);
	const result = await runCommand(command, rest);
	process.exit(result.code);
} catch (error) {
	process.stderr.write(`clanky: ${(error as Error).message}\n`);
	process.exit(1);
}

async function runCommand(commandName: string, commandArgs: string[]): Promise<CommandResult> {
	switch (commandName) {
		case "help":
		case "-h":
		case "--help":
			printHelp();
			return { code: 0 };
		case "face":
			return await runNodeScript("scripts/clanky.ts", commandArgs);
		case "up":
		case "status":
		case "down":
			return await runNodeScript("scripts/clanky-up.ts", [commandName, ...commandArgs]);
		case "worker":
			return await runWorker(commandArgs);
		case "transcript":
			return await runTranscriptCommand(commandArgs);
		case "transcript-run":
			return await runTranscriptRunner(commandArgs);
		case "install":
			await installCli();
			return { code: 0 };
		case "update":
			await updateCli(commandArgs);
			return { code: 0 };
		default:
			process.stderr.write(`clanky: unknown command '${commandName}'\n\n`);
			printHelp();
			return { code: 2 };
	}
}

function printHelp(): void {
	process.stdout.write(`Usage: clanky <command> [args]

Commands:
  face              Start the interactive Clanky face
  up                Ensure the Herdr session and headless Eve brain are running
  status            Print lifecycle status as JSON
  down              Stop the headless Eve brain pane
  worker <prompt>   Send one task to the running Clanky Eve brain and stream text
  transcript        List, read, tail, or print paths for worker transcripts
  transcript-run    Run a performer under Clanky's transcript capture
  install           Install this checkout's clanky binary into ~/.local/bin
  update            Fast-forward this checkout, install deps, and refresh the binary
  help              Show this help

Default command: face
`);
}

async function runNodeScript(relativePath: string, scriptArgs: readonly string[]): Promise<CommandResult> {
	return await runProcess(process.execPath, [join(REPO, relativePath), ...scriptArgs], { cwd: REPO });
}

async function runProcess(
	commandName: string,
	commandArgs: readonly string[],
	options: { cwd: string },
): Promise<CommandResult> {
	return await new Promise((resolvePromise, reject) => {
		const child = spawn(commandName, [...commandArgs], { cwd: options.cwd, stdio: "inherit" });
		child.on("error", reject);
		child.on("close", (code, signal) => {
			if (signal !== null) {
				reject(new Error(`${commandName} exited from signal ${signal}`));
				return;
			}
			resolvePromise({ code: code ?? 1 });
		});
	});
}

async function installCli(): Promise<void> {
	if (process.env.HOME === undefined || process.env.HOME.length === 0) {
		throw new Error("HOME is not set; cannot install ~/.local/bin/clanky");
	}
	await mkdir(INSTALL_DIR, { recursive: true });
	const existing = await lstat(INSTALL_PATH).catch((error: NodeJS.ErrnoException) => {
		if (error.code === "ENOENT") return undefined;
		throw error;
	});
	if (existing !== undefined) {
		if (!existing.isSymbolicLink()) {
			throw new Error(`${INSTALL_PATH} exists and is not a symlink`);
		}
		const target = await readlink(INSTALL_PATH);
		if (resolve(INSTALL_DIR, target) !== CLI_PATH) await rm(INSTALL_PATH);
	}
	const current = await lstat(INSTALL_PATH).catch(() => undefined);
	if (current === undefined) await symlink(CLI_PATH, INSTALL_PATH);
	process.stdout.write(`installed ${INSTALL_PATH} -> ${CLI_PATH}\n`);
}

async function updateCli(commandArgs: readonly string[]): Promise<void> {
	const runCheck = commandArgs.includes("--check");
	await runRequired("git", ["pull", "--ff-only"]);
	await runRequired("pnpm", ["install", "--frozen-lockfile"]);
	if (runCheck) await runRequired("pnpm", ["check"]);
	await installCli();
}

async function runRequired(commandName: string, commandArgs: readonly string[]): Promise<void> {
	const result = await runProcess(commandName, commandArgs, { cwd: REPO });
	if (result.code !== 0) throw new Error(`${commandName} ${commandArgs.join(" ")} failed with exit code ${result.code}`);
}

async function runWorker(commandArgs: readonly string[]): Promise<CommandResult> {
	const prompt = commandArgs.join(" ").trim();
	if (prompt.length === 0) {
		process.stderr.write("clanky worker requires a prompt\n");
		return { code: 2 };
	}
	const client = new Client({ host: `http://127.0.0.1:${resolvePort(process.env.CLANKY_EVE_PORT, 2000)}` });
	const session = client.session();
	const response = await session.send(prompt);
	let wroteText = false;
	for await (const event of response as AsyncIterable<EveEvent>) {
		const text = textFromEvent(event);
		if (text === undefined || text.length === 0) continue;
		process.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
		wroteText = true;
	}
	if (!wroteText) process.stdout.write("[no assistant text]\n");
	return { code: 0 };
}

async function runTranscriptCommand(commandArgs: readonly string[]): Promise<CommandResult> {
	const subcommand = commandArgs[0] ?? "help";
	const restArgs = commandArgs.slice(1);
	switch (subcommand) {
		case "help":
		case "-h":
		case "--help":
			printTranscriptHelp();
			return { code: 0 };
		case "list": {
			const json = restArgs.includes("--json");
			const runs = await listTranscriptRuns();
			if (json) {
				process.stdout.write(`${JSON.stringify(runs, null, 2)}\n`);
				return { code: 0 };
			}
			if (runs.length === 0) {
				process.stdout.write("no transcripts\n");
				return { code: 0 };
			}
			for (const run of runs) {
				process.stdout.write(`${run.agent}\t${run.runId}\t${run.startedAt}\t${run.path}\n`);
			}
			return { code: 0 };
		}
		case "read": {
			const options = parseTranscriptReadArgs(restArgs);
			const result = await readTranscript(options.agent, { lines: options.lines, runId: options.runId });
			process.stdout.write(result.text);
			if (result.text.length > 0 && !result.text.endsWith("\n")) process.stdout.write("\n");
			return { code: 0 };
		}
		case "path": {
			const options = parseTranscriptReadArgs(restArgs, 120);
			const run = await latestTranscriptRun(options.agent, { runId: options.runId });
			process.stdout.write(`${run.dir}\n`);
			return { code: 0 };
		}
		case "tail":
			return await tailTranscript(restArgs);
		default:
			process.stderr.write(`clanky transcript: unknown command '${subcommand}'\n\n`);
			printTranscriptHelp();
			return { code: 2 };
	}
}

function printTranscriptHelp(): void {
	process.stdout.write(`Usage: clanky transcript <command> [args]

Commands:
  list [--json]                         List transcript runs for this Herdr session
  read <agent> [--lines N] [--run-id ID] Read the latest transcript
  tail <agent> [--lines N] [--run-id ID] Follow transcript text
  path <agent> [--run-id ID]             Print the transcript run directory
`);
}

function parseTranscriptReadArgs(
	commandArgs: readonly string[],
	defaultLines = 120,
): { agent: string; lines: number; runId?: string } {
	let agent: string | undefined;
	let lines = defaultLines;
	let runId: string | undefined;
	for (let i = 0; i < commandArgs.length; i++) {
		const arg = commandArgs[i];
		if (arg === "--lines") {
			lines = parsePositiveInteger(commandArgs[++i], "--lines");
			continue;
		}
		if (arg === "--run-id") {
			runId = requiredValue(commandArgs[++i], "--run-id");
			continue;
		}
		if (arg?.startsWith("--lines=")) {
			lines = parsePositiveInteger(arg.slice("--lines=".length), "--lines");
			continue;
		}
		if (arg?.startsWith("--run-id=")) {
			runId = requiredValue(arg.slice("--run-id=".length), "--run-id");
			continue;
		}
		if (arg?.startsWith("-")) throw new Error(`unknown transcript option ${arg}`);
		if (agent !== undefined) throw new Error("transcript command accepts one agent");
		agent = arg;
	}
	if (agent === undefined || agent.length === 0) throw new Error("transcript command requires an agent");
	return { agent, lines, runId };
}

async function tailTranscript(commandArgs: readonly string[]): Promise<CommandResult> {
	const options = parseTranscriptReadArgs(commandArgs);
	const result = await readTranscript(options.agent, { lines: options.lines, runId: options.runId });
	process.stdout.write(result.text);
	const file = join(result.path, "stream.txt");
	let offset = await stat(file).then((s) => s.size);
	await new Promise<void>((resolvePromise, reject) => {
		const watcher = watch(file, { persistent: true }, async () => {
			try {
				const buffer = await readFile(file);
				if (buffer.byteLength <= offset) {
					offset = buffer.byteLength;
					return;
				}
				const next = buffer.subarray(offset);
				offset = buffer.byteLength;
				process.stdout.write(next);
			} catch (error) {
				watcher.close();
				reject(error);
			}
		});
		watcher.on("error", reject);
		process.once("SIGINT", () => {
			watcher.close();
			resolvePromise();
		});
	});
	return { code: 0 };
}

async function runTranscriptRunner(commandArgs: readonly string[]): Promise<CommandResult> {
	const parsed = parseTranscriptRunnerArgs(commandArgs);
	const runId = parsed.runId ?? newTranscriptRunId();
	const run = await createTranscriptRun({
		agent: parsed.agent,
		cwd: parsed.cwd,
		argv: parsed.argv,
		runId,
	});
	return await runTranscriptProcess(run, parsed.argv, parsed.cwd);
}

function parseTranscriptRunnerArgs(commandArgs: readonly string[]): {
	agent: string;
	cwd: string;
	runId?: string;
	argv: string[];
} {
	const dash = commandArgs.indexOf("--");
	if (dash === -1) throw new Error("transcript-run requires -- before the performer argv");
	const optionArgs = commandArgs.slice(0, dash);
	const argv = commandArgs.slice(dash + 1);
	if (argv.length === 0) throw new Error("transcript-run requires a performer argv");
	let agent: string | undefined;
	let cwd = process.cwd();
	let runId: string | undefined;
	for (let i = 0; i < optionArgs.length; i++) {
		const arg = optionArgs[i];
		if (arg === "--agent") {
			agent = requiredValue(optionArgs[++i], "--agent");
			continue;
		}
		if (arg === "--cwd") {
			cwd = requiredValue(optionArgs[++i], "--cwd");
			continue;
		}
		if (arg === "--run-id") {
			runId = requiredValue(optionArgs[++i], "--run-id");
			continue;
		}
		if (arg?.startsWith("--agent=")) {
			agent = requiredValue(arg.slice("--agent=".length), "--agent");
			continue;
		}
		if (arg?.startsWith("--cwd=")) {
			cwd = requiredValue(arg.slice("--cwd=".length), "--cwd");
			continue;
		}
		if (arg?.startsWith("--run-id=")) {
			runId = requiredValue(arg.slice("--run-id=".length), "--run-id");
			continue;
		}
		throw new Error(`unknown transcript-run option ${arg}`);
	}
	if (agent === undefined) throw new Error("transcript-run requires --agent");
	return { agent, cwd, runId, argv: [...argv] };
}

async function runTranscriptProcess(
	run: Awaited<ReturnType<typeof createTranscriptRun>>,
	argv: readonly string[],
	cwd: string,
): Promise<CommandResult> {
	const launch = process.stdin.isTTY ? scriptCommand(argv) : directCommand(argv);
	return await new Promise((resolvePromise, reject) => {
		const child = spawn(launch.command, launch.args, { cwd, stdio: ["inherit", "pipe", "pipe"] });
		let writeChain = Promise.resolve();
		let writeError: Error | undefined;
		let settled = false;
		const enqueue = (stream: "stdout" | "stderr", chunk: Buffer) => {
			const copy = Buffer.from(chunk);
			const output = stream === "stderr" ? process.stderr : process.stdout;
			output.write(copy);
			writeChain = writeChain
				.then(() => appendTranscriptChunk(run, stream, copy))
				.catch((error) => {
					writeError = error as Error;
				});
		};
		const settle = async (code: number | null, signal: NodeJS.Signals | null, error?: Error) => {
			if (settled) return;
			settled = true;
			await writeChain;
			await finishTranscriptRun(run, { exitCode: code, signal });
			if (error !== undefined) {
				reject(error);
				return;
			}
			// A transcript write failure must not mask the performer's own exit code;
			// the pane should reflect the performer, not Clanky's logging layer.
			if (writeError !== undefined) {
				process.stderr.write(`clanky: transcript write failed: ${writeError.message}\n`);
			}
			resolvePromise({ code: code ?? 1 });
		};
		child.stdout.on("data", (chunk: Buffer) => enqueue("stdout", chunk));
		child.stderr.on("data", (chunk: Buffer) => enqueue("stderr", chunk));
		child.on("error", (error) => {
			void settle(null, null, error);
		});
		child.on("close", (code, signal) => {
			void settle(code, signal);
		});
	});
}

function scriptCommand(argv: readonly string[]): { command: string; args: string[] } {
	if (process.platform === "darwin" || process.platform === "freebsd" || process.platform === "openbsd") {
		return { command: "script", args: ["-q", "/dev/null", ...argv] };
	}
	return { command: "script", args: ["-q", "-e", "-c", serializeCommandLine(argv), "/dev/null"] };
}

function directCommand(argv: readonly string[]): { command: string; args: string[] } {
	const commandName = argv[0];
	if (commandName === undefined) throw new Error("transcript-run requires a performer argv");
	return { command: commandName, args: [...argv.slice(1)] };
}

function parsePositiveInteger(value: string | undefined, label: string): number {
	const raw = requiredValue(value, label);
	const parsed = Number.parseInt(raw, 10);
	if (!Number.isInteger(parsed) || String(parsed) !== raw || parsed < 1) {
		throw new Error(`${label} must be a positive integer; got ${JSON.stringify(value)}`);
	}
	return parsed;
}

function requiredValue(value: string | undefined, label: string): string {
	if (value === undefined || value.length === 0) throw new Error(`${label} requires a value`);
	return value;
}

function textFromEvent(event: EveEvent): string | undefined {
	if (event.type !== "message.completed" && event.type !== "result.completed") return undefined;
	const data = event.data;
	if (typeof data !== "object" || data === null) return undefined;
	if ("message" in data && typeof data.message === "string") return data.message;
	if ("result" in data) {
		const result = data.result;
		if (typeof result === "string") return result;
		return JSON.stringify(result);
	}
	return undefined;
}
