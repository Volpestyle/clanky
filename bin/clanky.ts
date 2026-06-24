#!/usr/bin/env node
import { spawn } from "node:child_process";
import { lstat, mkdir, readlink, rm, symlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "eve/client";

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
