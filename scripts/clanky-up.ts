/**
 * Clanky lifecycle helper — the SSH cold-start seam for the iOS app (SPEC.md §5.1).
 *
 * The iOS app reaches the Mac over the tailnet via SSH and runs this script.
 * It is the one process that exists *below* Clanky: the relay channel lives
 * inside the eve brain, so it cannot start the brain. This can.
 *
 * It is idempotent. `up` ensures the persistent herdr session exists and that
 * Clanky's headless command host is running as a pane inside it. That host owns
 * the Eve brain and executes deterministic slash-command menu flows for iOS.
 * `status` reports without starting. `down` closes the command-host/brain pane,
 * verifies the brain actually stopped serving, and stops a recorded eve dev
 * server that outlived its pane.
 *
 * Output contract: every run — success, failure, or crash — writes exactly one
 * JSON line to stdout ({ok: false, error} on failure) so the iOS parser never
 * sees a bare stack trace.
 *
 * Run over SSH, e.g.:
 *   ssh mac 'cd ~/dev/clanky-eve-herdr && bash -lc "node scripts/clanky-up.ts --json"'
 *
 * Env:
 *   CLANKY_SESSION       herdr session name (default "clankies")
 *   CLANKY_REPO_DIR      repo dir for the brain pane cwd (default this checkout)
 *   CLANKY_EVE_PORT      relay/eve port (default 2000)
 *   CLANKY_EVE_BIND_HOST eve bind host (default "127.0.0.1" when Tailscale Serve
 *                        owns the port, otherwise "0.0.0.0"); legacy
 *                        CLANKY_EVE_HOST still honored (agent/lib/eve-address.ts)
 *   CLANKY_BRAIN_AGENT   herdr agent name for the brain pane (default "clanky")
 *   CLANKY_HERDR_BIN     herdr binary (default "herdr" on PATH)
 *   CLANKY_UP_SESSION_TIMEOUT_MS   wait for the herdr session (default 15000)
 *   CLANKY_EVE_HEALTH_TIMEOUT_MS   wait for the brain to serve (default 180000,
 *                                  same knob the face uses)
 */
import { execFile, execFileSync, spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	LOCAL_CONTEXT_TOKENS_ENV,
	parseLocalContextWindowTokens,
	resolveOllamaContextWindowTokens,
} from "../agent/lib/local-context.ts";
import { DEFAULT_LOCAL_BASE_URL, DEFAULT_LOCAL_MODEL } from "../agent/lib/config-defaults.ts";
import { resolveEveBindHost, resolveEvePort } from "../agent/lib/eve-address.ts";
import { readEnvLocal } from "../agent/lib/env-store.ts";
import {
	devServerRecordPath,
	readDevServerRecord,
	resolveDevServerTimeouts,
	resolveDurationMs,
	stopDevServerRecord,
	isPidAlive,
} from "../agent/lib/dev-server.ts";

const SESSION = process.env.CLANKY_SESSION ?? "clankies";
const REPO = resolve(process.env.CLANKY_REPO_DIR ?? join(dirname(fileURLToPath(import.meta.url)), ".."));
const TAILSCALE_BINARIES = ["tailscale", "/Applications/Tailscale.app/Contents/MacOS/Tailscale"] as const;
const BRAIN_AGENT = process.env.CLANKY_BRAIN_AGENT ?? "clanky";
const HERDR = process.env.CLANKY_HERDR_BIN ?? "herdr";
const DEV_SERVER_FILE = devServerRecordPath(REPO);

// Every failure path — including config parse errors and crashes — must emit
// the {ok:false,error} JSON contract; the iOS lifecycle parser reads stdout.
function emitFailure(error: unknown): void {
	const message = error instanceof Error ? error.message : String(error);
	process.stdout.write(`${JSON.stringify({ ok: false, error: message })}\n`);
}

let fatalHandled = false;
function handleFatal(reason: unknown): void {
	if (fatalHandled) return;
	fatalHandled = true;
	emitFailure(reason);
	process.exit(1);
}
process.on("uncaughtException", handleFatal);
process.on("unhandledRejection", handleFatal);

type LifecycleConfig = {
	readonly port: number;
	readonly host: string;
	readonly sessionTimeoutMs: number;
	readonly brainTimeoutMs: number;
};

// Port/host derivation can throw on bad env values, so it runs inside run()
// where the JSON error contract is already in force — never at module scope.
function resolveLifecycleConfig(): LifecycleConfig {
	const port = resolveEvePort(process.env);
	const host = resolveEveBindHost(process.env) ?? defaultEveHost(port);
	const sessionTimeoutMs = resolveDurationMs(process.env.CLANKY_UP_SESSION_TIMEOUT_MS, 15_000, "CLANKY_UP_SESSION_TIMEOUT_MS");
	const brainTimeoutMs = resolveDevServerTimeouts(process.env).healthTimeoutMs;
	return { port, host, sessionTimeoutMs, brainTimeoutMs };
}

function defaultEveHost(port: number): string {
	return tailscaleServeForwardsPort(port) ? "127.0.0.1" : "0.0.0.0";
}

function tailscaleServeForwardsPort(port: number): boolean {
	for (const binary of TAILSCALE_BINARIES) {
		try {
			const output = execFileSync(binary, ["serve", "status", "--json"], {
				encoding: "utf8",
				stdio: ["ignore", "pipe", "ignore"],
				timeout: 1500,
			});
			const parsed: unknown = JSON.parse(output);
			const tcp = isRecord(parsed) ? parsed.TCP : undefined;
			const entry = isRecord(tcp) ? tcp[String(port)] : undefined;
			if (isRecord(entry) && typeof entry.TCPForward === "string" && entry.TCPForward.length > 0) return true;
		} catch {
			// Tailscale is optional; direct tailnet binding remains the fallback.
		}
	}
	return false;
}

type SessionEntry = { name: string; running: boolean; socket_path: string; session_dir: string };
type AgentEntry = { name: string; pane_id: string; tab_id: string; workspace_id: string; agent_status?: string };
type Mode = "up" | "status" | "down";

function herdr(args: readonly string[]): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile(HERDR, args, { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
			if (error) {
				reject(new Error(`${HERDR} ${args.join(" ")} failed: ${stderr || error.message}`));
				return;
			}
			resolve(stdout);
		});
	});
}

function parseJson<T>(text: string): T {
	const start = text.indexOf("{");
	if (start === -1) throw new Error(`expected JSON, got: ${text.slice(0, 200)}`);
	return JSON.parse(text.slice(start)) as T;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function brainServing(port: number): Promise<boolean> {
	try {
		const response = await fetch(`http://127.0.0.1:${port}/eve/v1/info`, { signal: AbortSignal.timeout(1500) });
		return response.ok;
	} catch {
		return false;
	}
}

async function listSessions(): Promise<SessionEntry[]> {
	const out = await herdr(["session", "list", "--json"]);
	return parseJson<{ sessions: SessionEntry[] }>(out).sessions ?? [];
}

async function sessionRunning(): Promise<SessionEntry | undefined> {
	return (await listSessions()).find((s) => s.name === SESSION && s.running);
}

async function listAgents(): Promise<AgentEntry[]> {
	const out = await herdr(["--session", SESSION, "agent", "list"]);
	return parseJson<{ result?: { agents?: AgentEntry[] } }>(out).result?.agents ?? [];
}

function spawnSessionServer(): void {
	const child = spawn(HERDR, ["--session", SESSION, "server"], {
		cwd: REPO,
		detached: true,
		stdio: "ignore",
	});
	// A detached spawn failure (herdr missing, EACCES) otherwise raises an
	// unhandled 'error' event; report it and let the ensureSession poll decide.
	child.on("error", (error: Error) => {
		process.stderr.write(`clanky-up: failed to spawn herdr session server: ${error.message}\n`);
	});
	child.unref();
}

async function ensureSession(config: LifecycleConfig): Promise<SessionEntry> {
	const existing = await sessionRunning();
	if (existing) return existing;
	spawnSessionServer();
	const deadline = Date.now() + config.sessionTimeoutMs;
	while (Date.now() < deadline) {
		await sleep(500);
		const found = await sessionRunning();
		if (found) return found;
	}
	throw new Error(`session '${SESSION}' did not start within ${Math.round(config.sessionTimeoutMs / 1000)}s`);
}

async function findBrain(): Promise<AgentEntry | undefined> {
	return (await listAgents()).find((a) => a.name === BRAIN_AGENT);
}

async function startBrain(config: LifecycleConfig): Promise<AgentEntry> {
	const command = await clankyCommandHostCommand(config);
	await herdr([
		"--session",
		SESSION,
		"agent",
		"start",
		BRAIN_AGENT,
		"--cwd",
		REPO,
		"--no-focus",
		"--",
		...command,
	]);
	const deadline = Date.now() + config.brainTimeoutMs;
	while (Date.now() < deadline) {
		await sleep(500);
		if (await brainServing(config.port)) {
			const brain = await findBrain();
			if (brain) {
				await waitForCommandHostAttachment(config, 5000);
				return brain;
			}
		}
	}
	throw new Error(`brain '${BRAIN_AGENT}' did not serve on :${config.port} within ${Math.round(config.brainTimeoutMs / 1000)}s`);
}

async function clankyCommandHostCommand(config: LifecycleConfig): Promise<string[]> {
	const contextTokens = await contextTokensForOwnedBrain();
	return [
		"env",
		`CLANKY_REPO_DIR=${REPO}`,
		`CLANKY_EVE_BIND_HOST=${config.host}`,
		`CLANKY_EVE_PORT=${config.port}`,
		...(contextTokens === undefined ? [] : [`${LOCAL_CONTEXT_TOKENS_ENV}=${contextTokens}`]),
		process.execPath,
		"scripts/clanky.ts",
		"--command-host",
	];
}

async function contextTokensForOwnedBrain(): Promise<number | undefined> {
	const env = await readEnvLocal();
	const explicit = parseLocalContextWindowTokens(process.env[LOCAL_CONTEXT_TOKENS_ENV]) ?? parseLocalContextWindowTokens(env[LOCAL_CONTEXT_TOKENS_ENV]);
	if (explicit !== undefined) return explicit;
	const provider = process.env.CLANKY_MODEL_PROVIDER ?? env.CLANKY_MODEL_PROVIDER ?? "codex";
	if (provider !== "local") return undefined;
	return await resolveOllamaContextWindowTokens({
		baseURL: process.env.CLANKY_LOCAL_BASE_URL ?? env.CLANKY_LOCAL_BASE_URL ?? DEFAULT_LOCAL_BASE_URL,
		modelId: process.env.CLANKY_LOCAL_MODEL ?? env.CLANKY_LOCAL_MODEL ?? DEFAULT_LOCAL_MODEL,
	});
}

async function relayToken(): Promise<string> {
	const fromEnv = process.env.CLANKY_RELAY_TOKEN;
	if (fromEnv !== undefined && fromEnv.trim().length > 0) return fromEnv;
	return (await readEnvLocal()).CLANKY_RELAY_TOKEN ?? "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function relayCommandHostAttached(config: LifecycleConfig): Promise<boolean | undefined> {
	const token = await relayToken();
	if (token.trim().length === 0) return undefined;

	try {
		const response = await fetch(`http://127.0.0.1:${config.port}/relay/health`, {
			headers: { Authorization: `Bearer ${token}` },
			signal: AbortSignal.timeout(1500),
		});
		if (!response.ok) return undefined;
		const body: unknown = await response.json();
		if (!isRecord(body)) return undefined;
		const commandHost = body.commandHost;
		if (isRecord(commandHost)) return commandHost.attached === true;
		const face = body.face;
		return isRecord(face) ? face.attached === true : false;
	} catch {
		return undefined;
	}
}

async function waitForCommandHostAttachment(config: LifecycleConfig, timeoutMs: number): Promise<boolean> {
	if ((await relayToken()).trim().length === 0) return false;
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const attached = await relayCommandHostAttached(config);
		if (attached === true) return true;
		await sleep(250);
	}
	return false;
}

async function existingBrainNeedsCommandHostRestart(config: LifecycleConfig): Promise<boolean> {
	for (let i = 0; i < 5; i++) {
		const attached = await relayCommandHostAttached(config);
		if (attached === true || attached === undefined) return false;
		await sleep(500);
	}
	return true;
}

async function waitForBrainPaneGone(paneId: string): Promise<boolean> {
	for (let i = 0; i < 20; i++) {
		const brain = await findBrain();
		if (brain === undefined || brain.pane_id !== paneId) return true;
		await sleep(250);
	}
	return false;
}

async function waitForBrainStopServing(config: LifecycleConfig, timeoutMs: number): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		if (!(await brainServing(config.port))) return true;
		if (Date.now() >= deadline) return false;
		await sleep(250);
	}
}

function statusJson(config: LifecycleConfig, session: SessionEntry | undefined, brain: AgentEntry | undefined, serving: boolean, started: boolean) {
	return {
		ok: !!session && !!brain && serving,
		started,
		session: session ? { name: session.name, socket: session.socket_path } : { name: SESSION, running: false },
		brain: brain ? { agent: brain.name, paneId: brain.pane_id, status: brain.agent_status ?? "unknown" } : null,
		serving,
		relay: { host: config.host, port: config.port, url: `http://${config.host}:${config.port}` },
	};
}

async function runUp(config: LifecycleConfig): Promise<number> {
	const session = await ensureSession(config);
	let brain = await findBrain();
	let started = false;
	let serving = await brainServing(config.port);
	if (brain && serving && await existingBrainNeedsCommandHostRestart(config)) {
		await herdr(["--session", SESSION, "pane", "close", brain.pane_id]);
		await waitForBrainPaneGone(brain.pane_id);
		brain = undefined;
		serving = await brainServing(config.port);
	}
	if (brain && !serving) {
		await herdr(["--session", SESSION, "pane", "close", brain.pane_id]);
		await waitForBrainPaneGone(brain.pane_id);
		brain = undefined;
	}
	if (!brain || !serving) {
		brain = await startBrain(config);
		started = true;
	}
	serving = await brainServing(config.port);
	await waitForCommandHostAttachment(config, 2000);
	process.stdout.write(`${JSON.stringify(statusJson(config, session, brain, serving, started))}\n`);
	return serving ? 0 : 1;
}

async function runStatus(config: LifecycleConfig): Promise<number> {
	const session = await sessionRunning();
	const brain = session ? await findBrain() : undefined;
	const serving = session ? await brainServing(config.port) : false;
	process.stdout.write(`${JSON.stringify(statusJson(config, session, brain, serving, false))}\n`);
	return 0;
}

// Stop the command host pane AND verify the brain actually died. Closing the
// pane alone was the known zombie-eve root cause: the detached eve dev server
// recorded in .eve/dev-server.json can outlive the pane, so `down` also stops
// that pid (SIGTERM, then SIGKILL after grace) and reports what really happened
// instead of an unconditional ok:true.
async function runDown(config: LifecycleConfig): Promise<number> {
	const session = await sessionRunning();
	const brain = session ? await findBrain() : undefined;
	let paneClosed = brain === undefined;
	if (brain) {
		await herdr(["--session", SESSION, "pane", "close", brain.pane_id]);
		paneClosed = await waitForBrainPaneGone(brain.pane_id);
	}

	let serving = !(await waitForBrainStopServing(config, 5_000));
	let devServer: { pid: number; stopped: boolean } | null = null;
	if (serving) {
		const record = await readDevServerRecord(DEV_SERVER_FILE);
		if (record !== undefined && isPidAlive(record.pid)) {
			const timeouts = resolveDevServerTimeouts(process.env);
			let refused = false;
			await stopDevServerRecord(record, {
				stopTimeoutMs: timeouts.stopTimeoutMs,
				killTimeoutMs: timeouts.killTimeoutMs,
				onIdentityMismatch: () => {
					refused = true;
				},
			});
			devServer = { pid: record.pid, stopped: !refused && !isPidAlive(record.pid) };
		}
		serving = await brainServing(config.port);
	}

	const ok = paneClosed && !serving;
	process.stdout.write(`${JSON.stringify({ ok, closed: brain?.pane_id ?? null, paneClosed, serving, devServer })}\n`);
	return ok ? 0 : 1;
}

function parseMode(argv: readonly string[]): Mode {
	const positional = argv.filter((arg) => !arg.startsWith("-"));
	const mode = positional[0];
	if (positional.length > 1) throw new Error(`unknown extra arguments: ${positional.slice(1).join(" ")}`);
	if (mode === undefined || mode === "up") return "up";
	if (mode === "status" || mode === "down") return mode;
	throw new Error(`unknown mode '${mode}'; use up, status, or down`);
}

async function run(): Promise<number> {
	const mode = parseMode(process.argv.slice(2));
	const config = resolveLifecycleConfig();
	if (mode === "status") return await runStatus(config);
	if (mode === "down") return await runDown(config);
	return await runUp(config);
}

run()
	.then((code) => process.exit(code))
	.catch((error: unknown) => {
		emitFailure(error);
		process.exit(1);
	});
