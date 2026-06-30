#!/usr/bin/env node
import { spawn, type ChildProcess } from "node:child_process";
import { watch } from "node:fs";
import { lstat, mkdir, readlink, rm, symlink } from "node:fs/promises";
import { readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import { Client } from "eve/client";
import { serializeCommandLine } from "../agent/lib/coding-harness.ts";
import { startTranscriptFileTail } from "../agent/lib/transcript-file-tail.ts";
import { buildPairingLink, PAIRING_TOKEN_MISSING_MESSAGE, renderPairingQr } from "../agent/lib/pairing.ts";
import { buildEveDevServerEnv } from "../agent/lib/eve-dev-env.ts";
import {
	LOCAL_CONTEXT_TOKENS_ENV,
	parseLocalContextWindowTokens,
	resolveOllamaContextWindowTokens,
} from "../agent/lib/local-context.ts";
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
const ENV_PATH = join(REPO, ".env.local");
const DEV_SERVER_FILE = join(REPO, ".eve", "dev-server.json");
const DEFAULT_LOCAL_BASE_URL = "http://127.0.0.1:11434/v1";
const DEFAULT_LOCAL_MODEL = "qwen3-coder-next";
const BRAIN_HEALTH_TIMEOUT_MS = 180_000;
const BRAIN_OUTPUT_LIMIT = 8_000;
const SERVER_STOP_TIMEOUT_MS = 5_000;
const SERVER_KILL_TIMEOUT_MS = 2_000;
const DEV_BRAIN_SUPERVISE_POLL_MS = 5_000;
// Consecutive unhealthy polls before the supervisor restarts the owned brain.
// ~15s tolerates eve's own hot-reload blips (which recover well within that)
// while still rescuing a wedged worker that returns 503 indefinitely.
const DEV_BRAIN_SUPERVISE_FAILS = 3;
const DEV_SERVER_RECORD_STARTUP_GRACE_MS = 15_000;
const DEV_SERVER_UNHEALTHY_SETTLE_MS = 5_000;
const DEV_SERVER_RECORD_REPROBE_MS = 500;
const CLANKY_STARTUP_MODEL_FALLBACK_PROVIDER_ENV = "CLANKY_STARTUP_MODEL_FALLBACK_PROVIDER";
const CLANKY_STARTUP_MODEL_FALLBACK_ENV_NAMES_ENV = "CLANKY_STARTUP_MODEL_FALLBACK_ENV_NAMES";

type CommandResult = {
	code: number;
};

type StartupModelFallback = {
	readonly provider: "xai" | "gemini";
	readonly envNames: string;
};

type DevBrain = {
	readonly child?: ChildProcess;
	readonly host: string;
	readonly owned: boolean;
};

type DevServerRecord = {
	readonly pid: number;
	readonly updatedAt?: string;
	readonly url: string;
};
type DiscoveredDevServer = {
	readonly host: string;
	readonly record: DevServerRecord;
	readonly state: "healthy" | "reachable";
};

type EveEvent = {
	type: string;
	data?: unknown;
};

const args = process.argv.slice(2);
const command = args[0] ?? "dev";
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
		case "dev":
			return await runDev(commandArgs);
		case "up":
		case "status":
		case "down":
			return await runNodeScript("scripts/clanky-up.ts", [commandName, ...commandArgs]);
		case "pair":
			return await runPair(commandArgs);
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
  dev               Start a hot-reloadable Clanky dev loop (default)
  up                Ensure the Herdr session and Clanky command host are running
  status            Print lifecycle status as JSON
  down              Stop the Clanky command host / brain pane
  pair              Print a QR (or --link) the Clanky iOS app scans to connect
  worker <prompt>   Send one task to the running Clanky Eve brain and stream text
  transcript        List, read, tail, or print paths for worker transcripts
  transcript-run    Run a performer under Clanky's transcript capture
  install           Install this checkout's clanky binary into ~/.local/bin
  update            Fast-forward this checkout, install deps, and refresh the binary
  help              Show this help

Default command: dev
`);
}

async function runNodeScript(relativePath: string, scriptArgs: readonly string[]): Promise<CommandResult> {
	return await runProcess(process.execPath, [join(REPO, relativePath), ...scriptArgs], { cwd: REPO });
}

async function runDev(commandArgs: readonly string[]): Promise<CommandResult> {
	assertInteractiveFaceTty();
	const brain = await ensureDevBrain();
	const supervisor = superviseDevBrain(brain);
	try {
		return await runWatchedFace(commandArgs);
	} finally {
		await supervisor.shutdown();
	}
}

type DevBrainSupervisor = {
	shutdown(): Promise<void>;
};

// Keep the owned dev brain alive: eve's dev server can wedge with its HTTP front
// still listening but the runtime worker dead (every route 503), which the face
// surfaces but cannot fix because it only attaches to this brain. Poll health and
// restart the brain process after sustained unhealth or an outright exit. Stays
// silent — the face owns the TTY and renders the eve status itself. When the brain
// was discovered rather than started here, do nothing: we neither own nor stop it.
function superviseDevBrain(initial: DevBrain): DevBrainSupervisor {
	if (!initial.owned || initial.child === undefined) {
		return { shutdown: async () => {} };
	}
	let child = initial.child;
	let host = initial.host;
	let removeExitCleanup = installDevBrainExitCleanup(child);
	let removeChildExitRestart = (): void => {};
	let failures = 0;
	let restarting = false;
	let stopped = false;

	const restartOwnedDevBrain = async (): Promise<void> => {
		if (stopped || restarting) return;
		restarting = true;
		try {
			removeExitCleanup();
			removeChildExitRestart();
			if (!hasChildExited(child)) await stopDevBrain(child);
			const next = await startDevBrain();
			child = next.child ?? child;
			host = next.host;
			removeExitCleanup = installDevBrainExitCleanup(child);
			removeChildExitRestart = installDevBrainExitRestart(child, restartOwnedDevBrain);
			failures = 0;
		} catch {
			// Restart failed (e.g. health never came up); a later tick retries.
		} finally {
			restarting = false;
		}
	};
	removeChildExitRestart = installDevBrainExitRestart(child, restartOwnedDevBrain);

	const tick = async (): Promise<void> => {
		if (stopped || restarting) return;
		const childExited = hasChildExited(child);
		const state = childExited ? "down" : await probeHost(host);
		if (stopped || restarting) return;
		if (state === "healthy") {
			failures = 0;
			return;
		}
		failures = childExited ? DEV_BRAIN_SUPERVISE_FAILS : failures + 1;
		if (failures < DEV_BRAIN_SUPERVISE_FAILS) return;
		await restartOwnedDevBrain();
	};

	const timer = setInterval(() => void tick(), DEV_BRAIN_SUPERVISE_POLL_MS);
	timer.unref();

	return {
		async shutdown(): Promise<void> {
			stopped = true;
			clearInterval(timer);
			removeExitCleanup();
			removeChildExitRestart();
			if (!hasChildExited(child)) await stopDevBrain(child);
		},
	};
}

async function ensureDevBrain(): Promise<DevBrain> {
	const discovered = await discoverDevServer();
	if (discovered !== undefined) {
		if (discovered.state === "healthy") return { host: discovered.host, owned: false };
		if (await waitForDiscoveredDevServerHealth(discovered)) return { host: discovered.host, owned: false };
		await stopUnhealthyDevServerRecord(discovered);
		return await startDevBrain();
	}

	const staleRecord = await staleDevServerRecord();
	if (staleRecord !== undefined) await stopStaleDevServerRecord(staleRecord);

	const host = clankyHost();
	const state = await probeHost(host);
	if (state === "healthy") return { host, owned: false };
	if (state === "reachable") {
		if (await waitForHostHealth(host, DEV_SERVER_UNHEALTHY_SETTLE_MS)) return { host, owned: false };
		throw new Error(`Eve dev server on ${host} is reachable but unhealthy, and no live ${DEV_SERVER_FILE} process was available to restart`);
	}

	return await startDevBrain();
}

async function runWatchedFace(commandArgs: readonly string[]): Promise<CommandResult> {
	const nodeArgs = [
		"--watch",
		"--watch-preserve-output",
		join(REPO, "scripts/clanky.ts"),
		...commandArgs,
	];
	return await new Promise<CommandResult>((resolvePromise, reject) => {
		const child = spawn(process.execPath, nodeArgs, { cwd: REPO, stdio: "inherit" });
		let interrupted = false;
		let settled = false;
		const cleanup = (): void => {
			process.off("SIGINT", onSignal);
			process.off("SIGTERM", onSignal);
		};
		const finish = (result: CommandResult | Error): void => {
			if (settled) return;
			settled = true;
			cleanup();
			if (result instanceof Error) reject(result);
			else resolvePromise(result);
		};
		const onSignal = (signal: NodeJS.Signals): void => {
			interrupted = true;
			if (!hasChildExited(child)) child.kill(signal);
		};
		process.once("SIGINT", onSignal);
		process.once("SIGTERM", onSignal);
		child.once("error", finish);
		child.once("close", (code, signal) => {
			if (signal !== null) {
				if (interrupted && (signal === "SIGINT" || signal === "SIGTERM")) {
					finish({ code: 0 });
					return;
				}
				finish(new Error(`${process.execPath} exited from signal ${signal}`));
				return;
			}
			finish({ code: code ?? 1 });
		});
	});
}

async function startDevBrain(): Promise<DevBrain> {
	const host = clankyHost();
	const output: string[] = [];
	const appendOutput = (chunk: Buffer): void => {
		output.push(chunk.toString("utf8"));
		while (output.join("").length > BRAIN_OUTPUT_LIMIT) output.shift();
	};
	const child = spawn(join(REPO, "node_modules", ".bin", "eve"), ["dev", "--no-ui", "--port", String(clankyPort())], {
		cwd: REPO,
		env: await buildDevBrainEnv(),
		stdio: ["ignore", "pipe", "pipe"],
	});
	child.stdout?.on("data", appendOutput);
	child.stderr?.on("data", appendOutput);
	await waitForDevBrainHealth(child, host, () => output.join(""));
	return { child, host, owned: true };
}

async function buildDevBrainEnv(): Promise<NodeJS.ProcessEnv> {
	const env: NodeJS.ProcessEnv = {
		...buildEveDevServerEnv(process.env, clankyHost(), clankyPort()),
		CLANKY_REPO_DIR: REPO,
	};
	const localEnv = await readLocalEnv();
	const provider = process.env.CLANKY_MODEL_PROVIDER ?? localEnv.CLANKY_MODEL_PROVIDER ?? "codex";
	const startupFallback = missingApiKeyStartupFallback(provider, process.env, localEnv);
	if (startupFallback !== undefined) {
		process.env[CLANKY_STARTUP_MODEL_FALLBACK_PROVIDER_ENV] = startupFallback.provider;
		process.env[CLANKY_STARTUP_MODEL_FALLBACK_ENV_NAMES_ENV] = startupFallback.envNames;
		return {
			...env,
			CLANKY_MODEL_PROVIDER: "codex",
			[CLANKY_STARTUP_MODEL_FALLBACK_PROVIDER_ENV]: startupFallback.provider,
			[CLANKY_STARTUP_MODEL_FALLBACK_ENV_NAMES_ENV]: startupFallback.envNames,
		};
	}
	delete process.env[CLANKY_STARTUP_MODEL_FALLBACK_PROVIDER_ENV];
	delete process.env[CLANKY_STARTUP_MODEL_FALLBACK_ENV_NAMES_ENV];
	const explicitContextTokens =
		parseLocalContextWindowTokens(env[LOCAL_CONTEXT_TOKENS_ENV]) ??
		parseLocalContextWindowTokens(localEnv[LOCAL_CONTEXT_TOKENS_ENV]);
	if (explicitContextTokens !== undefined) return env;

	if (provider !== "local") return env;
	const contextTokens = await resolveOllamaContextWindowTokens({
		baseURL: process.env.CLANKY_LOCAL_BASE_URL ?? localEnv.CLANKY_LOCAL_BASE_URL ?? DEFAULT_LOCAL_BASE_URL,
		modelId: process.env.CLANKY_LOCAL_MODEL ?? localEnv.CLANKY_LOCAL_MODEL ?? DEFAULT_LOCAL_MODEL,
	});
	return contextTokens === undefined ? env : { ...env, [LOCAL_CONTEXT_TOKENS_ENV]: String(contextTokens) };
}

function missingApiKeyStartupFallback(
	provider: string,
	env: NodeJS.ProcessEnv,
	localEnv: Record<string, string>,
): StartupModelFallback | undefined {
	if (provider === "xai" && !hasAnyEnvValue(env, localEnv, ["CLANKY_XAI_API_KEY", "XAI_API_KEY"])) {
		return { provider, envNames: "CLANKY_XAI_API_KEY or XAI_API_KEY" };
	}
	if (provider === "gemini" && !hasAnyEnvValue(env, localEnv, ["CLANKY_GEMINI_API_KEY", "GEMINI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY"])) {
		return { provider, envNames: "CLANKY_GEMINI_API_KEY, GEMINI_API_KEY, or GOOGLE_GENERATIVE_AI_API_KEY" };
	}
	return undefined;
}

function hasAnyEnvValue(env: NodeJS.ProcessEnv, localEnv: Record<string, string>, keys: readonly string[]): boolean {
	return keys.some((key) => (env[key]?.trim() ?? localEnv[key]?.trim() ?? "").length > 0);
}

async function readLocalEnv(): Promise<Record<string, string>> {
	try {
		const parsed = parseEnv(await readFile(ENV_PATH, "utf8"));
		const env: Record<string, string> = {};
		for (const [key, value] of Object.entries(parsed)) {
			if (value !== undefined) env[key] = value;
		}
		return env;
	} catch {
		return {};
	}
}

// `clanky pair` — the QR source for the iOS app's one-time pairing (SPEC §4.4).
// Encodes the tailnet relay URL + bearer token into a `clanky://connect` deep
// link and renders it as a scannable terminal QR. After one scan the phone
// stores the credentials in Keychain and auto-reconnects over Tailscale on every
// launch. `--link` prints just the URL (AirDrop / tap it instead of scanning).
async function runPair(commandArgs: readonly string[]): Promise<CommandResult> {
	const flags = new Set(commandArgs.filter((arg) => arg.startsWith("--")));
	const linkOnly = flags.has("--link");
	const useHttps = flags.has("--https");
	const hostArg = readFlagValue(commandArgs, "--host");
	const portArg = readFlagValue(commandArgs, "--port");

	const localEnv = await readLocalEnv();
	const token = process.env.CLANKY_RELAY_TOKEN ?? localEnv.CLANKY_RELAY_TOKEN ?? "";
	if (token.length === 0) {
		process.stderr.write(`clanky pair: ${PAIRING_TOKEN_MISSING_MESSAGE}\n`);
		return { code: 1 };
	}

	const port = resolvePort(portArg ?? process.env.CLANKY_EVE_PORT ?? localEnv.CLANKY_EVE_PORT, 2000);
	const { relayUrl, url } = await buildPairingLink({
		token,
		port,
		host: hostArg,
		configuredHost: process.env.CLANKY_EVE_HOST ?? localEnv.CLANKY_EVE_HOST,
		https: useHttps,
	});

	if (linkOnly) {
		process.stdout.write(`${url}\n`);
		return { code: 0 };
	}

	const qr = await renderPairingQr(url);
	process.stdout.write(`\nScan with the Clanky iOS app to pair (relay ${relayUrl}):\n\n`);
	process.stdout.write(`${qr}\n`);
	process.stdout.write(`Or open this link on the phone:\n  ${url}\n\n`);
	return { code: 0 };
}

function readFlagValue(argv: readonly string[], flag: string): string | undefined {
	const idx = argv.indexOf(flag);
	if (idx === -1) return undefined;
	const value = argv[idx + 1];
	return value !== undefined && !value.startsWith("--") ? value : undefined;
}

async function waitForDevBrainHealth(
	child: ChildProcess,
	host: string,
	output: () => string,
	timeoutMs = BRAIN_HEALTH_TIMEOUT_MS,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		if (hasChildExited(child)) throw new Error(devBrainExitMessage(child, output()));
		if ((await probeHost(host)) === "healthy") return;
		if (Date.now() > deadline) throw new Error(`Clanky brain did not become healthy on ${host}`);
		await sleep(500);
	}
}

async function discoverDevServer(): Promise<DiscoveredDevServer | undefined> {
	const record = await readDevServerRecord();
	if (record === undefined || !isPidAlive(record.pid)) return undefined;
	const host = normalizeHost(record.url);
	if (host === undefined) return undefined;
	const initialState = await probeHost(host);
	if (initialState === "healthy" || initialState === "reachable") return { host, record, state: initialState };

	const graceMs = devServerRecordStartupGraceMs(record);
	if (graceMs <= 0) return undefined;
	const deadline = Date.now() + graceMs;
	while (Date.now() < deadline && isPidAlive(record.pid)) {
		await sleep(Math.min(DEV_SERVER_RECORD_REPROBE_MS, Math.max(0, deadline - Date.now())));
		const state = await probeHost(host);
		if (state === "healthy" || state === "reachable") return { host, record, state };
	}
	return undefined;
}

async function waitForDiscoveredDevServerHealth(discovered: DiscoveredDevServer): Promise<boolean> {
	const graceMs = Math.max(DEV_SERVER_UNHEALTHY_SETTLE_MS, devServerRecordStartupGraceMs(discovered.record));
	if (graceMs <= 0) return false;
	return await waitForHostHealth(discovered.host, graceMs, () => isPidAlive(discovered.record.pid));
}

async function waitForHostHealth(host: string, timeoutMs: number, shouldContinue: () => boolean = () => true): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline && shouldContinue()) {
		await sleep(Math.min(DEV_SERVER_RECORD_REPROBE_MS, Math.max(0, deadline - Date.now())));
		if ((await probeHost(host)) === "healthy") return true;
	}
	return false;
}

async function stopUnhealthyDevServerRecord(discovered: DiscoveredDevServer): Promise<void> {
	process.stderr.write(`clanky: Eve dev server pid ${discovered.record.pid} at ${discovered.host} is reachable but unhealthy; restarting it for dev\n`);
	await stopDevServerRecord(discovered.record, "unhealthy");
}

async function staleDevServerRecord(): Promise<DevServerRecord | undefined> {
	const record = await readDevServerRecord();
	if (record === undefined || !isPidAlive(record.pid) || record.pid === process.pid) return undefined;
	const host = normalizeHost(record.url);
	if (host === undefined) return undefined;
	return (await probeHost(host)) === "down" ? record : undefined;
}

async function stopStaleDevServerRecord(record: DevServerRecord): Promise<void> {
	const host = normalizeHost(record.url) ?? record.url;
	process.stderr.write(`clanky: stale Eve dev server pid ${record.pid} is alive but ${host} is unreachable; stopping it before restart\n`);
	await stopDevServerRecord(record, "stale");
}

async function stopDevServerRecord(record: DevServerRecord, reason: "stale" | "unhealthy"): Promise<void> {
	if (record.pid === process.pid) return;
	try {
		process.kill(record.pid, "SIGTERM");
	} catch {
		return;
	}
	if (await waitForPidExit(record.pid, SERVER_STOP_TIMEOUT_MS)) return;
	process.stderr.write(`clanky: ${reason} Eve dev server pid ${record.pid} did not exit after SIGTERM; forcing stop\n`);
	try {
		process.kill(record.pid, "SIGKILL");
	} catch {
		return;
	}
	await waitForPidExit(record.pid, SERVER_KILL_TIMEOUT_MS);
}

function devServerRecordStartupGraceMs(record: DevServerRecord): number {
	if (record.updatedAt === undefined) return 0;
	const updatedAt = Date.parse(record.updatedAt);
	if (!Number.isFinite(updatedAt)) return 0;
	const ageMs = Math.max(0, Date.now() - updatedAt);
	return Math.max(0, DEV_SERVER_RECORD_STARTUP_GRACE_MS - ageMs);
}

async function readDevServerRecord(): Promise<DevServerRecord | undefined> {
	let text: string;
	try {
		text = await readFile(DEV_SERVER_FILE, "utf8");
	} catch {
		return undefined;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return undefined;
	}
	if (!isRecord(parsed)) return undefined;
	if (typeof parsed.pid !== "number" || !Number.isSafeInteger(parsed.pid)) return undefined;
	if (typeof parsed.url !== "string" || parsed.url.trim().length === 0) return undefined;
	return {
		pid: parsed.pid,
		updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : undefined,
		url: parsed.url,
	};
}

async function probeHost(host: string): Promise<"healthy" | "reachable" | "down"> {
	try {
		const response = await fetch(`${host}/eve/v1/info`);
		return response.ok ? "healthy" : "reachable";
	} catch {
		return "down";
	}
}

function clankyPort(): number {
	return resolvePort(process.env.CLANKY_EVE_PORT, 2000);
}

function clankyHost(): string {
	return `http://127.0.0.1:${clankyPort()}`;
}

function normalizeHost(value: string): string | undefined {
	try {
		const url = new URL(value);
		if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
		return url.origin;
	} catch {
		return undefined;
	}
}

function isPidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return typeof error === "object" && error !== null && "code" in error && String(error.code) === "EPERM";
	}
}

async function waitForPidExit(pid: number, timeoutMs: number): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (!isPidAlive(pid)) return true;
		await sleep(100);
	}
	return !isPidAlive(pid);
}

function installDevBrainExitCleanup(child: ChildProcess | undefined): () => void {
	if (child === undefined) return () => {};
	const cleanup = (): void => {
		if (!hasChildExited(child)) child.kill("SIGTERM");
	};
	process.once("beforeExit", cleanup);
	process.once("exit", cleanup);
	return () => {
		process.off("beforeExit", cleanup);
		process.off("exit", cleanup);
	};
}

function installDevBrainExitRestart(child: ChildProcess, restart: () => Promise<void>): () => void {
	const onExit = (): void => {
		void restart();
	};
	child.once("exit", onExit);
	return () => {
		child.off("exit", onExit);
	};
}

async function stopDevBrain(child: ChildProcess): Promise<void> {
	if (hasChildExited(child)) return;
	child.kill("SIGTERM");
	if (await waitForChildExit(child, SERVER_STOP_TIMEOUT_MS)) return;
	child.kill("SIGKILL");
	await waitForChildExit(child, SERVER_KILL_TIMEOUT_MS);
}

function hasChildExited(child: ChildProcess): boolean {
	return child.exitCode !== null || child.signalCode !== null;
}

async function waitForChildExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
	if (hasChildExited(child)) return true;
	return await new Promise<boolean>((resolvePromise) => {
		let settled = false;
		const finish = (exited: boolean): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			child.off("exit", onExit);
			child.off("error", onError);
			resolvePromise(exited);
		};
		const onExit = (): void => finish(true);
		const onError = (): void => finish(true);
		const timeout = setTimeout(() => finish(false), timeoutMs);
		child.once("exit", onExit);
		child.once("error", onError);
		if (hasChildExited(child)) finish(true);
	});
}

function devBrainExitMessage(child: ChildProcess, output: string): string {
	const status =
		child.exitCode !== null
			? `exit code ${child.exitCode}`
			: child.signalCode !== null
				? `signal ${child.signalCode}`
				: "unknown status";
	const recent = output.trim();
	return recent.length === 0
		? `Eve dev server exited before becoming healthy (${status})`
		: `Eve dev server exited before becoming healthy (${status}). Recent output:\n${recent}`;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function assertInteractiveFaceTty(): void {
	if (process.stdin.isTTY === true && process.stdout.isTTY === true) return;
	throw new Error("interactive Clanky face requires a TTY; use `clanky worker ...` or `clanky status` for noninteractive use");
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
	if (process.stdin.isTTY === true && process.stdout.isTTY === true) {
		return await runTranscriptPtyBridge(run, argv, cwd);
	}
	return await runTranscriptPipeCapture(run, argv, cwd);
}

async function runTranscriptPipeCapture(
	run: Awaited<ReturnType<typeof createTranscriptRun>>,
	argv: readonly string[],
	cwd: string,
): Promise<CommandResult> {
	const launch = directCommand(argv);
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

async function runTranscriptPtyBridge(
	run: Awaited<ReturnType<typeof createTranscriptRun>>,
	argv: readonly string[],
	cwd: string,
): Promise<CommandResult> {
	const rawPath = join(run.dir, "stream.script.ansi");
	await writeFile(rawPath, "");
	const launch = scriptCommand(argv, rawPath);
	const tail = await startTranscriptFileTail(run, rawPath);
	return await new Promise((resolvePromise, reject) => {
		const child = spawn(launch.command, launch.args, { cwd, stdio: "inherit" });
		let settled = false;
		const forwardResize = (): void => {
			if (child.killed) return;
			child.kill("SIGWINCH");
		};
		process.stdout.on("resize", forwardResize);
		process.on("SIGWINCH", forwardResize);
		const settle = async (code: number | null, signal: NodeJS.Signals | null, error?: Error) => {
			if (settled) return;
			settled = true;
			process.stdout.off("resize", forwardResize);
			process.off("SIGWINCH", forwardResize);
			const writeError = await tail.stop();
			await finishTranscriptRun(run, { exitCode: code, signal });
			if (error !== undefined) {
				reject(error);
				return;
			}
			if (writeError !== undefined) {
				process.stderr.write(`clanky: transcript write failed: ${writeError.message}\n`);
			}
			resolvePromise({ code: code ?? 1 });
		};
		child.on("error", (error) => {
			void settle(null, null, error);
		});
		child.on("close", (code, signal) => {
			void settle(code, signal);
		});
	});
}

function scriptCommand(argv: readonly string[], outputPath: string): { command: string; args: string[] } {
	if (process.platform === "darwin" || process.platform === "freebsd" || process.platform === "openbsd") {
		return { command: "script", args: ["-q", "-e", "-F", outputPath, ...argv] };
	}
	return { command: "script", args: ["-q", "-f", "-e", "-c", serializeCommandLine(argv), outputPath] };
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

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
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
