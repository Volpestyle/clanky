#!/usr/bin/env node
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { watch } from "node:fs";
import { lstat, mkdir, readlink, rm, symlink } from "node:fs/promises";
import { open, readFile, stat, writeFile } from "node:fs/promises";
import { constants as osConstants } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Client } from "eve/client";
import {
	DEFAULT_LOCAL_BASE_URL,
	DEFAULT_LOCAL_MODEL,
	formatEnvNameAlternatives,
	firstEnvValue,
	GEMINI_API_KEY_ENV_NAMES,
	XAI_API_KEY_ENV_NAMES,
} from "../agent/lib/config-defaults.ts";
import { DEFAULT_EVE_PORT, parsePortValue, resolveEveBindHost, resolveEvePort } from "../agent/lib/eve-address.ts";
import { readEnvLocal } from "../agent/lib/env-store.ts";
import {
	devServerRecordPath,
	discoverDevServer,
	hasChildExited,
	isPidAlive,
	normalizeHost,
	probeEveHost,
	readDevServerRecord,
	resolveDevServerTimeouts,
	stopDevServerChild,
	stopDevServerRecord,
	waitForDiscoveredDevServerHealth,
	waitForHostHealth,
	type DevServerRecord,
	type DevServerTimeouts,
	type DiscoveredDevServer,
} from "../agent/lib/dev-server.ts";
import { parsePaneRoster, resolveSelf, resolveTarget, stampMessage } from "../agent/lib/herdr-message.ts";
import { herdrStreamLines, type HerdrRequest, type HerdrStream } from "../agent/lib/herdr-socket.ts";
import {
	classifyWorkerState,
	formatWakeMessage,
	isSettledAgentStatus,
	parseWatchEventLine,
	watcherSelfName,
	workerRunPaths,
	type WatchEvent,
	type WorkerRunPaths,
	type WorkerSentinels,
	type WorkerWakeOutcome,
} from "../agent/lib/worker-watch.ts";
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
import { searchHerdrHistory } from "../agent/lib/history-search.ts";
import { listPaneRecordings, readPaneRecording, startPaneRecorder } from "../agent/lib/pane-recorder.ts";

const CLI_PATH = fileURLToPath(import.meta.url);
const REPO = resolve(dirname(CLI_PATH), "..");
const INSTALL_DIR = join(process.env.HOME ?? "", ".local/bin");
const INSTALL_PATH = join(INSTALL_DIR, "clanky");
const DEV_SERVER_FILE = devServerRecordPath(REPO);
const DEV_TIMEOUTS: DevServerTimeouts = resolveDevServerTimeouts(process.env);
const BRAIN_OUTPUT_LIMIT = 8_000;
const DEV_BRAIN_SUPERVISE_POLL_MS = 5_000;
// Consecutive unhealthy polls before the supervisor restarts the owned brain.
// ~15s tolerates eve's own hot-reload blips (which recover well within that)
// while still rescuing a wedged worker that returns 503 indefinitely.
const DEV_BRAIN_SUPERVISE_FAILS = 3;
const CLANKY_STARTUP_MODEL_FALLBACK_PROVIDER_ENV = "CLANKY_STARTUP_MODEL_FALLBACK_PROVIDER";
const CLANKY_STARTUP_MODEL_FALLBACK_ENV_NAMES_ENV = "CLANKY_STARTUP_MODEL_FALLBACK_ENV_NAMES";
const TRANSCRIPT_FORWARDED_SIGNALS: readonly NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];

// Children this CLI owns (the dev brain, transcript performers). The crash
// envelope below SIGTERMs them so a CLI bug never orphans an eve server.
const ownedChildren = new Set<ChildProcess>();

function trackOwnedChild(child: ChildProcess): () => void {
	ownedChildren.add(child);
	const untrack = (): void => {
		ownedChildren.delete(child);
	};
	child.once("exit", untrack);
	child.once("error", untrack);
	return untrack;
}

// Crash-safety envelope: Node >=24 terminates on an unhandled rejection with no
// cleanup, which would orphan the owned eve dev server. Log, kill owned
// children, exit non-zero.
let fatalErrorHandled = false;
function handleFatalError(kind: string, reason: unknown): void {
	if (fatalErrorHandled) return;
	fatalErrorHandled = true;
	const detail = reason instanceof Error ? reason.stack ?? reason.message : String(reason);
	process.stderr.write(`clanky: fatal ${kind}: ${detail}\n`);
	for (const child of ownedChildren) {
		try {
			if (!hasChildExited(child)) child.kill("SIGTERM");
		} catch {
			// Child already gone.
		}
	}
	process.exit(1);
}
process.on("uncaughtException", (error) => handleFatalError("uncaughtException", error));
process.on("unhandledRejection", (reason) => handleFatalError("unhandledRejection", reason));

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

type EveEvent = {
	type: string;
	data?: unknown;
};

const args = process.argv.slice(2);
const command = args[0] ?? "dev";
const rest = args.slice(1);
const execFileAsync = promisify(execFile);

try {
	resolveEvePort(process.env);
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
		case "msg":
			return await runMsg(commandArgs);
		case "watch":
			return await runWatch(commandArgs);
		case "transcript":
			return await runTranscriptCommand(commandArgs);
		case "transcript-run":
			return await runTranscriptRunner(commandArgs);
		case "transcript-exec":
			return await runTranscriptExec(commandArgs);
		case "recorder":
			return await runRecorderCommand(commandArgs);
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
  msg <name> <text> Send a peer worker a submitted prompt, stamped with your verified name
  watch <agent>     Watch one worker to completion, deliver one [worker <outcome>] wake, exit
  transcript        List, read, search, tail, or print paths for worker transcripts
  transcript-run    Run a performer under Clanky's transcript capture
  recorder          Inspect or seed the session-wide pane recorder store
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

	let ticking = false;
	const tick = async (): Promise<void> => {
		if (stopped || restarting || ticking) return;
		ticking = true;
		try {
			const childExited = hasChildExited(child);
			const state = childExited ? "down" : await probeEveHost(host, DEV_TIMEOUTS.probeTimeoutMs);
			if (stopped || restarting) return;
			if (state === "healthy") {
				failures = 0;
				return;
			}
			failures = childExited ? DEV_BRAIN_SUPERVISE_FAILS : failures + 1;
			if (failures < DEV_BRAIN_SUPERVISE_FAILS) return;
			await restartOwnedDevBrain();
		} finally {
			ticking = false;
		}
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
	const discovered = await discoverDevServer(DEV_SERVER_FILE, DEV_TIMEOUTS);
	if (discovered !== undefined) {
		if (discovered.state === "healthy") return { host: discovered.host, owned: false };
		if (await waitForDiscoveredDevServerHealth(discovered, DEV_TIMEOUTS)) return { host: discovered.host, owned: false };
		await stopUnhealthyDevServerRecord(discovered);
		return await startDevBrain();
	}

	const staleRecord = await staleDevServerRecord();
	if (staleRecord !== undefined) await stopStaleDevServerRecord(staleRecord);

	const host = clankyHost();
	const state = await probeEveHost(host, DEV_TIMEOUTS.probeTimeoutMs);
	if (state === "healthy") return { host, owned: false };
	if (state === "reachable") {
		if (await waitForHostHealth(host, DEV_TIMEOUTS.unhealthySettleMs, DEV_TIMEOUTS)) return { host, owned: false };
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
	trackOwnedChild(child);
	child.stdout?.on("data", appendOutput);
	child.stderr?.on("data", appendOutput);
	try {
		await waitForDevBrainHealth(child, host, () => output.join(""));
	} catch (error) {
		// A brain that never became healthy must not be left running (the known
		// zombie-eve path): stop the child we just spawned before rethrowing.
		await stopDevBrain(child);
		throw error;
	}
	return { child, host, owned: true };
}

async function buildDevBrainEnv(): Promise<NodeJS.ProcessEnv> {
	const env: NodeJS.ProcessEnv = {
		...buildEveDevServerEnv(process.env, clankyHost(), clankyPort()),
		CLANKY_REPO_DIR: REPO,
	};
	const localEnv = await readEnvLocal();
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
	if (provider === "xai" && firstEnvValue(XAI_API_KEY_ENV_NAMES, env, localEnv) === undefined) {
		return { provider, envNames: formatEnvNameAlternatives(XAI_API_KEY_ENV_NAMES) };
	}
	if (provider === "gemini" && firstEnvValue(GEMINI_API_KEY_ENV_NAMES, env, localEnv) === undefined) {
		return { provider, envNames: formatEnvNameAlternatives(GEMINI_API_KEY_ENV_NAMES) };
	}
	return undefined;
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

	const localEnv = await readEnvLocal();
	const token = process.env.CLANKY_RELAY_TOKEN ?? localEnv.CLANKY_RELAY_TOKEN ?? "";
	if (token.length === 0) {
		process.stderr.write(`clanky pair: ${PAIRING_TOKEN_MISSING_MESSAGE}\n`);
		return { code: 1 };
	}

	const port = parsePortValue(portArg ?? process.env.CLANKY_EVE_PORT ?? localEnv.CLANKY_EVE_PORT, DEFAULT_EVE_PORT);
	const { relayUrl, url } = await buildPairingLink({
		token,
		port,
		host: hostArg,
		// Bind-host semantics (bare host, never a base URL); wildcard hosts are
		// filtered by the pairing resolver. process.env wins over .env.local.
		configuredHost: resolveEveBindHost({ ...localEnv, ...process.env }),
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
	timeoutMs = DEV_TIMEOUTS.healthTimeoutMs,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		if (hasChildExited(child)) throw new Error(devBrainExitMessage(child, output()));
		if ((await probeEveHost(host, DEV_TIMEOUTS.probeTimeoutMs)) === "healthy") return;
		if (Date.now() > deadline) throw new Error(`Clanky brain did not become healthy on ${host}`);
		await sleep(500);
	}
}

async function stopUnhealthyDevServerRecord(discovered: DiscoveredDevServer): Promise<void> {
	process.stderr.write(`clanky: Eve dev server pid ${discovered.record.pid} at ${discovered.host} is reachable but unhealthy; restarting it for dev\n`);
	await stopRecordedDevServer(discovered.record, "unhealthy");
}

async function staleDevServerRecord(): Promise<DevServerRecord | undefined> {
	const record = await readDevServerRecord(DEV_SERVER_FILE);
	if (record === undefined || !isPidAlive(record.pid) || record.pid === process.pid) return undefined;
	const host = normalizeHost(record.url);
	if (host === undefined) return undefined;
	return (await probeEveHost(host, DEV_TIMEOUTS.probeTimeoutMs)) === "down" ? record : undefined;
}

async function stopStaleDevServerRecord(record: DevServerRecord): Promise<void> {
	const host = normalizeHost(record.url) ?? record.url;
	process.stderr.write(`clanky: stale Eve dev server pid ${record.pid} is alive but ${host} is unreachable; stopping it before restart\n`);
	await stopRecordedDevServer(record, "stale");
}

async function stopRecordedDevServer(record: DevServerRecord, reason: "stale" | "unhealthy"): Promise<void> {
	await stopDevServerRecord(record, {
		stopTimeoutMs: DEV_TIMEOUTS.stopTimeoutMs,
		killTimeoutMs: DEV_TIMEOUTS.killTimeoutMs,
		onForceKill: (pid) => {
			process.stderr.write(`clanky: ${reason} Eve dev server pid ${pid} did not exit after SIGTERM; forcing stop\n`);
		},
		onIdentityMismatch: (pid) => {
			process.stderr.write(`clanky: recorded Eve dev server pid ${pid} belongs to another process now; not signaling it\n`);
		},
	});
}

function clankyPort(): number {
	return resolveEvePort(process.env);
}

function clankyHost(): string {
	return `http://127.0.0.1:${clankyPort()}`;
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
	await stopDevServerChild(child, { stopTimeoutMs: DEV_TIMEOUTS.stopTimeoutMs, killTimeoutMs: DEV_TIMEOUTS.killTimeoutMs });
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
	const client = new Client({ host: `http://127.0.0.1:${resolveEvePort(process.env)}` });
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

async function herdrCapture(herdrArgs: readonly string[]): Promise<string> {
	const { stdout } = await execFileAsync("herdr", [...herdrArgs], { maxBuffer: 8 * 1024 * 1024 });
	return stdout;
}

// `clanky msg <name> <text>` — provenance-stamped peer messaging between herdr
// workers. It resolves the target against the LIVE roster (never a pane id a
// message claimed for itself), refuses ambiguous/self targets, and prefixes the
// message with the sender's verified `[from <name>]` (from HERDR_PANE_ID) so the
// recipient never has to trust a self-declared id. See agent/lib/herdr-message.ts.
async function runMsg(commandArgs: readonly string[]): Promise<CommandResult> {
	const target = commandArgs[0];
	const text = commandArgs.slice(1).join(" ").trim();
	if (target === undefined || target.length === 0 || text.length === 0) {
		process.stderr.write("Usage: clanky msg <name|pane-id> <message>\n");
		return { code: 2 };
	}
	const selfPaneId = process.env.HERDR_PANE_ID;
	if (selfPaneId === undefined || selfPaneId.length === 0) {
		process.stderr.write(
			"clanky msg: must run inside a herdr pane (HERDR_PANE_ID unset); cannot stamp a verified sender identity\n",
		);
		return { code: 1 };
	}
	const roster = parsePaneRoster(await herdrCapture(["pane", "list"]));
	const self = resolveSelf(roster, selfPaneId);
	const resolution = resolveTarget(roster, target, selfPaneId);
	if (!resolution.ok) {
		process.stderr.write(`clanky msg: ${resolution.reason}\n`);
		if (resolution.candidates.length > 0) {
			process.stderr.write("live panes:\n");
			for (const candidate of resolution.candidates) {
				process.stderr.write(`  ${candidate.name}\t${candidate.paneId}\t${candidate.agent ?? "?"}\t${candidate.status ?? "?"}\n`);
			}
		}
		return { code: 1 };
	}
	await herdrCapture(["pane", "run", resolution.pane.paneId, stampMessage(self.name, text)]);
	process.stdout.write(`sent to ${resolution.pane.name} (${resolution.pane.paneId}) as ${self.name}\n`);
	return { code: 0 };
}

// Statuses flicker while a harness redraws; only a settle that survives this
// re-probe window (or a sentinel file) is treated as a completion.
const WATCH_SETTLE_DEBOUNCE_MS = 1_500;
const WATCH_RESUBSCRIBE_DELAY_MS = 1_000;
const WATCH_MAX_SUBSCRIBE_FAILURES = 5;

// `clanky watch <agent>` — the one-shot completion watcher armed at the spawn
// seam (agent/lib/worker-watch.ts). It blocks on herdr agent-status events for
// one worker, classifies the outcome against the run dir's DONE/BLOCKED
// sentinels (completion truth; agent_status is heuristic), delivers exactly one
// `[worker <outcome>]` wake to the --notify target through the `clanky msg`
// machinery (live-roster resolution + `[from watch:<slug>]` stamp), and exits.
// Re-arming is the next spawn's (or the lead's) job.
async function runWatch(commandArgs: readonly string[]): Promise<CommandResult> {
	const options = parseWatchArgs(commandArgs);
	const paths = options.runDir === undefined ? undefined : workerRunPaths(options.runDir, options.agent);
	const deadline = options.timeoutMs === undefined ? undefined : Date.now() + options.timeoutMs;
	let subscribeFailures = 0;
	while (true) {
		const probe = await probeWatchedAgent(options.agent);
		if (probe.kind === "unreachable") {
			process.stderr.write(`clanky watch: herdr unreachable: ${probe.message}\n`);
			return { code: 1 };
		}
		const sentinels = paths === undefined ? undefined : await readWorkerSentinels(paths);
		if (probe.kind === "gone") {
			const state = classifyWorkerState({ paneAlive: false, sentinels });
			return await deliverWorkerWake({
				...options,
				paths,
				outcome: state === "running" || state === "idle" ? "dead" : state,
			});
		}
		const state = classifyWorkerState({ paneAlive: true, agentStatus: probe.status, sentinels });
		if (state === "done" || state === "blocked") {
			return await deliverWorkerWake({ ...options, paths, outcome: state, agentStatus: probe.status });
		}
		// An arm-time settled status without a sentinel is not a completion (a
		// worker still booting can read idle); wait for a post-arm settle event.
		const wait = await waitForWorkerSettle({ agent: options.agent, paneId: probe.paneId, paths, deadline });
		if (wait.kind === "deliver") {
			return await deliverWorkerWake({ ...options, paths, outcome: wait.outcome, agentStatus: wait.agentStatus });
		}
		if (wait.kind === "timeout") {
			const finalProbe = await probeWatchedAgent(options.agent);
			const finalSentinels = paths === undefined ? undefined : await readWorkerSentinels(paths);
			const finalStatus = finalProbe.kind === "alive" ? finalProbe.status : undefined;
			const finalState = classifyWorkerState({
				paneAlive: finalProbe.kind === "alive",
				agentStatus: finalStatus,
				sentinels: finalSentinels,
			});
			return await deliverWorkerWake({
				...options,
				paths,
				outcome: finalState === "running" ? "timeout" : finalState,
				agentStatus: finalStatus,
			});
		}
		subscribeFailures = wait.subscribed ? 0 : subscribeFailures + 1;
		if (subscribeFailures >= WATCH_MAX_SUBSCRIBE_FAILURES) {
			process.stderr.write(`clanky watch: giving up after ${subscribeFailures} failed event subscriptions\n`);
			return { code: 1 };
		}
		await sleep(WATCH_RESUBSCRIBE_DELAY_MS);
	}
}

function parseWatchArgs(commandArgs: readonly string[]): {
	agent: string;
	notify: string;
	runDir?: string;
	timeoutMs?: number;
} {
	let agent: string | undefined;
	let notify = "clanky:main";
	let runDir: string | undefined;
	let timeoutMs: number | undefined;
	for (let i = 0; i < commandArgs.length; i++) {
		const arg = commandArgs[i];
		if (arg === "--notify") {
			notify = requiredValue(commandArgs[++i], "--notify");
			continue;
		}
		if (arg === "--run-dir") {
			runDir = requiredValue(commandArgs[++i], "--run-dir");
			continue;
		}
		if (arg === "--timeout") {
			timeoutMs = parsePositiveInteger(commandArgs[++i], "--timeout");
			continue;
		}
		if (arg?.startsWith("--notify=")) {
			notify = requiredValue(arg.slice("--notify=".length), "--notify");
			continue;
		}
		if (arg?.startsWith("--run-dir=")) {
			runDir = requiredValue(arg.slice("--run-dir=".length), "--run-dir");
			continue;
		}
		if (arg?.startsWith("--timeout=")) {
			timeoutMs = parsePositiveInteger(arg.slice("--timeout=".length), "--timeout");
			continue;
		}
		if (arg?.startsWith("-")) throw new Error(`unknown watch option ${arg}`);
		if (agent !== undefined) throw new Error("watch accepts one worker agent");
		agent = arg;
	}
	if (agent === undefined || agent.length === 0) {
		throw new Error("Usage: clanky watch <agent> [--notify <target>] [--run-dir <run-dir>] [--timeout <ms>]");
	}
	return { agent, notify, runDir, timeoutMs };
}

type WatchedAgentProbe =
	| { kind: "alive"; paneId: string; status?: string }
	| { kind: "gone" }
	| { kind: "unreachable"; message: string };

// Resolve the worker fresh by durable name; never trust a stored pane id.
async function probeWatchedAgent(agent: string): Promise<WatchedAgentProbe> {
	let stdout: string;
	try {
		stdout = await herdrCapture(["agent", "get", agent]);
	} catch (error) {
		const err = error as NodeJS.ErrnoException & { stderr?: string };
		if (typeof err.stderr === "string" && err.stderr.includes("agent_not_found")) return { kind: "gone" };
		return { kind: "unreachable", message: err.stderr?.trim() || err.message };
	}
	let envelope: { result?: { agent?: { pane_id?: unknown; agent_status?: unknown } } };
	try {
		envelope = JSON.parse(stdout) as { result?: { agent?: { pane_id?: unknown; agent_status?: unknown } } };
	} catch {
		return { kind: "unreachable", message: "could not parse `herdr agent get` output as JSON" };
	}
	const agentInfo = envelope.result?.agent;
	const paneId = typeof agentInfo?.pane_id === "string" ? agentInfo.pane_id : undefined;
	if (paneId === undefined || paneId.length === 0) return { kind: "gone" };
	const status = typeof agentInfo?.agent_status === "string" ? agentInfo.agent_status : undefined;
	return { kind: "alive", paneId, status };
}

async function fileExists(path: string): Promise<boolean> {
	return await stat(path).then(
		() => true,
		() => false,
	);
}

async function readWorkerSentinels(paths: WorkerRunPaths): Promise<WorkerSentinels> {
	const [done, blocked] = await Promise.all([fileExists(paths.donePath), fileExists(paths.blockedPath)]);
	return { done, blocked };
}

type WorkerSettleWait =
	| { kind: "deliver"; outcome: WorkerWakeOutcome; agentStatus?: string }
	| { kind: "timeout" }
	| { kind: "resubscribe"; subscribed: boolean };

// One events.subscribe stream: agent-status changes for the worker's pane (no
// status filter, so done AND blocked AND idle all fire) plus pane.closed /
// pane.exited for pane death — a dead pane's status subscription goes silent
// rather than closing, so death needs its own events.
async function waitForWorkerSettle(input: {
	agent: string;
	paneId: string;
	paths?: WorkerRunPaths;
	deadline?: number;
}): Promise<WorkerSettleWait> {
	return await new Promise((resolvePromise) => {
		let finished = false;
		let subscribed = false;
		let processing = Promise.resolve();
		let timer: ReturnType<typeof setTimeout> | undefined;
		let stream: HerdrStream | undefined;
		const finish = (result: WorkerSettleWait): void => {
			if (finished) return;
			finished = true;
			if (timer !== undefined) clearTimeout(timer);
			stream?.close();
			resolvePromise(result);
		};
		const handleEvent = async (event: WatchEvent): Promise<void> => {
			if (finished) return;
			if (event.kind === "subscribed") {
				subscribed = true;
				// Close the arm->subscribe gap: a sentinel written before the
				// subscription started produces no event, so re-check once.
				const sentinels = input.paths === undefined ? undefined : await readWorkerSentinels(input.paths);
				if (sentinels?.done === true) finish({ kind: "deliver", outcome: "done" });
				else if (sentinels?.blocked === true) finish({ kind: "deliver", outcome: "blocked" });
				return;
			}
			if (event.kind === "error") {
				process.stderr.write(`clanky watch: subscription error: ${event.message}\n`);
				finish({ kind: "resubscribe", subscribed });
				return;
			}
			if (event.paneId !== input.paneId) return;
			if (event.kind === "pane-gone") {
				const sentinels = input.paths === undefined ? undefined : await readWorkerSentinels(input.paths);
				const state = classifyWorkerState({ paneAlive: false, sentinels });
				finish({ kind: "deliver", outcome: state === "running" || state === "idle" ? "dead" : state });
				return;
			}
			if (!isSettledAgentStatus(event.status)) return;
			await sleep(WATCH_SETTLE_DEBOUNCE_MS);
			if (finished) return;
			const sentinels = input.paths === undefined ? undefined : await readWorkerSentinels(input.paths);
			const probe = await probeWatchedAgent(input.agent);
			if (probe.kind === "unreachable") {
				finish({ kind: "resubscribe", subscribed });
				return;
			}
			const status = probe.kind === "alive" ? probe.status : undefined;
			const state = classifyWorkerState({ paneAlive: probe.kind === "alive", agentStatus: status, sentinels });
			if (state === "running") return;
			finish({ kind: "deliver", outcome: state, agentStatus: status ?? event.status });
		};
		if (input.deadline !== undefined) {
			timer = setTimeout(() => finish({ kind: "timeout" }), Math.max(0, input.deadline - Date.now()));
		}
		stream = herdrStreamLines(
			{
				id: `clanky_watch_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
				method: "events.subscribe",
				params: {
					subscriptions: [
						{ type: "pane.agent_status_changed", pane_id: input.paneId },
						{ type: "pane.closed" },
						{ type: "pane.exited" },
					],
				},
			} satisfies HerdrRequest,
			(line) => {
				const event = parseWatchEventLine(line);
				if (event === undefined) return;
				processing = processing.then(() => handleEvent(event)).catch(() => finish({ kind: "resubscribe", subscribed }));
			},
			() => finish({ kind: "resubscribe", subscribed }),
			() => finish({ kind: "resubscribe", subscribed }),
		);
	});
}

async function deliverWorkerWake(input: {
	agent: string;
	notify: string;
	paths?: WorkerRunPaths;
	outcome: WorkerWakeOutcome;
	agentStatus?: string;
	timeoutMs?: number;
}): Promise<CommandResult> {
	const resultPath =
		input.paths !== undefined && (await fileExists(input.paths.resultPath)) ? input.paths.resultPath : undefined;
	const message = formatWakeMessage({
		agent: input.agent,
		outcome: input.outcome,
		runId: input.paths?.runId,
		resultPath,
		agentStatus: input.agentStatus,
		hasRunDir: input.paths !== undefined,
		timeoutMs: input.timeoutMs,
	});
	const roster = parsePaneRoster(await herdrCapture(["pane", "list"]));
	// The watcher legitimately wakes the pane that armed it, so the notify
	// target resolves with no self-pane exclusion (empty self pane id).
	let resolution = resolveTarget(roster, input.notify, "");
	if (!resolution.ok && input.notify !== "clanky:main") {
		process.stderr.write(`clanky watch: notify target failed (${resolution.reason}); falling back to clanky:main\n`);
		resolution = resolveTarget(roster, "clanky:main", "");
	}
	if (!resolution.ok) {
		process.stderr.write(`clanky watch: cannot deliver wake: ${resolution.reason}\nundelivered: ${message}\n`);
		return { code: 1 };
	}
	await herdrCapture(["pane", "run", resolution.pane.paneId, stampMessage(watcherSelfName(input.agent), message)]);
	process.stdout.write(`delivered to ${resolution.pane.name} (${resolution.pane.paneId}): ${message}\n`);
	return { code: input.outcome === "timeout" ? 1 : 0 };
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
		case "search":
			return await searchTranscripts(restArgs);
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
  search <query> [--limit N] [--regex] [--json]
                                         Search worker transcripts and pane recordings
`);
}

async function searchTranscripts(commandArgs: readonly string[]): Promise<CommandResult> {
	let query: string | undefined;
	let limit = 20;
	let regex = false;
	let json = false;
	for (let i = 0; i < commandArgs.length; i++) {
		const arg = commandArgs[i];
		if (arg === "--limit") {
			limit = parsePositiveInteger(commandArgs[++i], "--limit");
			continue;
		}
		if (arg?.startsWith("--limit=")) {
			limit = parsePositiveInteger(arg.slice("--limit=".length), "--limit");
			continue;
		}
		if (arg === "--regex") {
			regex = true;
			continue;
		}
		if (arg === "--json") {
			json = true;
			continue;
		}
		if (arg?.startsWith("-")) throw new Error(`unknown search option ${arg}`);
		if (query !== undefined) throw new Error("transcript search accepts one query (quote multi-word queries)");
		query = arg;
	}
	if (query === undefined || query.length === 0) throw new Error("transcript search requires a query");
	const result = await searchHerdrHistory(query, { limit, regex });
	if (json) {
		process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
		return { code: 0 };
	}
	if (result.matches.length === 0) {
		process.stdout.write(`no matches (${result.engine})\n`);
		return { code: 0 };
	}
	for (const match of result.matches) {
		const where = match.kind === "pane" ? `pane ${match.paneId ?? match.id}` : `agent ${match.agent ?? "?"}`;
		process.stdout.write(`${where}\t${match.id}/${match.file}:${match.lineNumber}\t${match.line}\n`);
	}
	if (result.truncated) process.stdout.write(`… truncated at ${limit} matches\n`);
	return { code: 0 };
}

async function runRecorderCommand(commandArgs: readonly string[]): Promise<CommandResult> {
	const subcommand = commandArgs[0] ?? "help";
	const restArgs = commandArgs.slice(1);
	switch (subcommand) {
		case "help":
		case "-h":
		case "--help":
			printRecorderHelp();
			return { code: 0 };
		case "list": {
			const json = restArgs.includes("--json");
			const recordings = await listPaneRecordings();
			if (json) {
				process.stdout.write(`${JSON.stringify(recordings, null, 2)}\n`);
				return { code: 0 };
			}
			if (recordings.length === 0) {
				process.stdout.write("no pane recordings\n");
				return { code: 0 };
			}
			for (const recording of recordings) {
				const state = recording.endedAt === undefined ? "open" : "ended";
				const covered = recording.coveredBy === undefined ? "" : `\tcovered-by:${recording.coveredBy}`;
				process.stdout.write(
					`${recording.paneId}\t${state}\t${recording.recordingId}\t${recording.startedAt}${covered}\n`,
				);
			}
			return { code: 0 };
		}
		case "read": {
			const options = parseRecorderReadArgs(restArgs);
			const result = await readPaneRecording(options.pane, {
				lines: options.lines,
				anchor: options.anchor,
				skip: options.skip,
			});
			process.stdout.write(result.text);
			if (result.text.length > 0 && !result.text.endsWith("\n")) process.stdout.write("\n");
			return { code: 0 };
		}
		case "seed": {
			// One-shot pane.read snapshot of every live pane into the store. Run
			// before a herdr upgrade/handoff so pre-upgrade tails survive.
			const handle = await startPaneRecorder({ seedOnly: true, log: (message) => process.stderr.write(`${message}\n`) });
			if (handle === undefined) {
				process.stderr.write("recorder seed: could not start (herdr unreachable?)\n");
				return { code: 1 };
			}
			const recordings = await listPaneRecordings();
			process.stdout.write(`seeded ${recordings.filter((recording) => recording.endedAt === undefined).length} open recording(s)\n`);
			return { code: 0 };
		}
		default:
			process.stderr.write(`clanky recorder: unknown command '${subcommand}'\n\n`);
			printRecorderHelp();
			return { code: 2 };
	}
}

function printRecorderHelp(): void {
	process.stdout.write(`Usage: clanky recorder <command> [args]

Commands:
  list [--json]                                List pane recordings for this Herdr session
  read <pane> [--lines N] [--anchor head|tail] [--skip N]
                                               Read recorded pane history (head reads from the start)
  seed                                         Snapshot every live pane into the store once
`);
}

function parseRecorderReadArgs(commandArgs: readonly string[]): {
	pane: string;
	lines: number;
	anchor: "head" | "tail";
	skip: number;
} {
	let pane: string | undefined;
	let lines = 120;
	let anchor: "head" | "tail" = "tail";
	let skip = 0;
	for (let i = 0; i < commandArgs.length; i++) {
		const arg = commandArgs[i];
		if (arg === "--lines") {
			lines = parsePositiveInteger(commandArgs[++i], "--lines");
			continue;
		}
		if (arg?.startsWith("--lines=")) {
			lines = parsePositiveInteger(arg.slice("--lines=".length), "--lines");
			continue;
		}
		if (arg === "--skip") {
			skip = parseNonNegativeInteger(commandArgs[++i], "--skip");
			continue;
		}
		if (arg?.startsWith("--skip=")) {
			skip = parseNonNegativeInteger(arg.slice("--skip=".length), "--skip");
			continue;
		}
		if (arg === "--anchor" || arg?.startsWith("--anchor=")) {
			const value = arg === "--anchor" ? commandArgs[++i] : arg.slice("--anchor=".length);
			if (value !== "head" && value !== "tail") throw new Error("--anchor must be head or tail");
			anchor = value;
			continue;
		}
		if (arg?.startsWith("-")) throw new Error(`unknown recorder option ${arg}`);
		if (pane !== undefined) throw new Error("recorder read accepts one pane id");
		pane = arg;
	}
	if (pane === undefined || pane.length === 0) throw new Error("recorder read requires a pane id");
	return { pane, lines, anchor, skip };
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
	// Read only the appended delta per watch event (a long-running performer's
	// stream.txt grows without bound; re-reading the whole file each event does
	// not scale). `reading` coalesces bursts of watch events.
	let reading = false;
	await new Promise<void>((resolvePromise, reject) => {
		const watcher = watch(file, { persistent: true }, async () => {
			if (reading) return;
			reading = true;
			try {
				const { size } = await stat(file);
				if (size <= offset) {
					offset = size;
					return;
				}
				const handle = await open(file, "r");
				try {
					const length = size - offset;
					const chunk = Buffer.alloc(length);
					const { bytesRead } = await handle.read(chunk, 0, length, offset);
					offset += bytesRead;
					process.stdout.write(chunk.subarray(0, bytesRead));
				} finally {
					await handle.close();
				}
			} catch (error) {
				watcher.close();
				reject(error);
			} finally {
				reading = false;
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

// Trap SIGINT/SIGTERM/SIGHUP for the lifetime of a transcript run so a pane
// close or kill can't take the wrapper down before the write chain flushes and
// finishTranscriptRun records the run's end (otherwise runs look live forever
// and performers are orphaned). Signals are forwarded to the performer; after
// finalize the wrapper re-raises so its own exit status stays truthful.
function installTranscriptSignalForwarding(child: ChildProcess): () => void {
	const handlers = new Map<NodeJS.Signals, () => void>();
	for (const signal of TRANSCRIPT_FORWARDED_SIGNALS) {
		const forward = (): void => {
			if (!hasChildExited(child)) child.kill(signal);
		};
		handlers.set(signal, forward);
		process.on(signal, forward);
	}
	return () => {
		for (const [signal, forward] of handlers) process.off(signal, forward);
	};
}

// The performer died from (or we relayed) a signal: re-raise it on ourselves
// with default disposition restored so the wrapper reports the same signal
// instead of collapsing it to exit 1. The fallback exit covers hosts where the
// re-raise is swallowed.
function reRaiseSignal(signal: NodeJS.Signals): CommandResult {
	process.kill(process.pid, signal);
	const signalNumber = osConstants.signals[signal];
	return { code: typeof signalNumber === "number" ? 128 + signalNumber : 1 };
}

async function runTranscriptPipeCapture(
	run: Awaited<ReturnType<typeof createTranscriptRun>>,
	argv: readonly string[],
	cwd: string,
): Promise<CommandResult> {
	const launch = directCommand(argv);
	return await new Promise((resolvePromise, reject) => {
		const child = spawn(launch.command, launch.args, { cwd, stdio: ["inherit", "pipe", "pipe"] });
		trackOwnedChild(child);
		const removeSignalForwarding = installTranscriptSignalForwarding(child);
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
			removeSignalForwarding();
			if (error !== undefined) {
				reject(error);
				return;
			}
			// A transcript write failure must not mask the performer's own exit code;
			// the pane should reflect the performer, not Clanky's logging layer.
			if (writeError !== undefined) {
				process.stderr.write(`clanky: transcript write failed: ${writeError.message}\n`);
			}
			if (signal !== null) {
				resolvePromise(reRaiseSignal(signal));
				return;
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
	const launch = await scriptCommand(argv, rawPath, run.dir);
	const tail = await startTranscriptFileTail(run, rawPath);
	return await new Promise((resolvePromise, reject) => {
		const child = spawn(launch.command, launch.args, { cwd, stdio: "inherit" });
		trackOwnedChild(child);
		const removeSignalForwarding = installTranscriptSignalForwarding(child);
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
			removeSignalForwarding();
			if (error !== undefined) {
				reject(error);
				return;
			}
			if (writeError !== undefined) {
				process.stderr.write(`clanky: transcript write failed: ${writeError.message}\n`);
			}
			if (signal !== null) {
				resolvePromise(reRaiseSignal(signal));
				return;
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

async function scriptCommand(argv: readonly string[], outputPath: string, runDir: string): Promise<{ command: string; args: string[] }> {
	const argvPath = join(runDir, "script-argv.json");
	await writeFile(argvPath, `${JSON.stringify({ argv })}\n`, { mode: 0o600 });
	const execArgv = [process.execPath, CLI_PATH, "transcript-exec", argvPath];
	if (process.platform === "darwin" || process.platform === "freebsd" || process.platform === "openbsd") {
		return { command: "script", args: ["-q", "-e", "-F", outputPath, ...execArgv] };
	}
	return { command: "script", args: ["-q", "-f", "-e", "-c", serializeCommandLine(execArgv), outputPath] };
}

async function runTranscriptExec(commandArgs: readonly string[]): Promise<CommandResult> {
	if (commandArgs.length !== 1) throw new Error("transcript-exec requires an argv file");
	const argvFile = commandArgs[0];
	if (argvFile === undefined || argvFile.length === 0) throw new Error("transcript-exec requires an argv file");
	const parsed = JSON.parse(await readFile(argvFile, "utf8")) as unknown;
	if (!isTranscriptExecPayload(parsed)) throw new Error("invalid transcript-exec argv file");
	return await runProcess(parsed.argv[0], parsed.argv.slice(1), { cwd: process.cwd() });
}

function isTranscriptExecPayload(value: unknown): value is { argv: [string, ...string[]] } {
	if (value === null || typeof value !== "object" || !("argv" in value)) return false;
	const argv = (value as { argv?: unknown }).argv;
	return Array.isArray(argv) && argv.length > 0 && argv.every((arg) => typeof arg === "string" && arg.length > 0);
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

function parseNonNegativeInteger(value: string | undefined, label: string): number {
	const raw = requiredValue(value, label);
	const parsed = Number.parseInt(raw, 10);
	if (!Number.isInteger(parsed) || String(parsed) !== raw || parsed < 0) {
		throw new Error(`${label} must be a non-negative integer; got ${JSON.stringify(value)}`);
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
