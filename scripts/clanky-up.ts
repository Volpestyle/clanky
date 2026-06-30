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
 * `status` reports without starting. `down` closes the command-host/brain pane.
 *
 * Run over SSH, e.g.:
 *   ssh mac 'cd ~/dev/clanky-eve-herdr && bash -lc "node scripts/clanky-up.ts --json"'
 *
 * Env:
 *   CLANKY_SESSION     herdr session name (default "clankies")
 *   CLANKY_REPO_DIR    repo dir for the brain pane cwd (default this checkout)
 *   CLANKY_EVE_PORT    relay/eve port (default 2000)
 *   CLANKY_EVE_HOST    eve bind host (default "127.0.0.1" when Tailscale Serve
 *                      owns the port, otherwise "0.0.0.0")
 *   CLANKY_BRAIN_AGENT herdr agent name for the brain pane (default "clanky")
 *   CLANKY_HERDR_BIN   herdr binary (default "herdr" on PATH)
 */
import { execFile, execFileSync, spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import {
	LOCAL_CONTEXT_TOKENS_ENV,
	parseLocalContextWindowTokens,
	resolveOllamaContextWindowTokens,
} from "../agent/lib/local-context.ts";

const SESSION = process.env.CLANKY_SESSION ?? "clankies";
const REPO = resolve(process.env.CLANKY_REPO_DIR ?? join(dirname(fileURLToPath(import.meta.url)), ".."));
const PORT = resolvePort(process.env.CLANKY_EVE_PORT, 2000);
const TAILSCALE_BINARIES = ["tailscale", "/Applications/Tailscale.app/Contents/MacOS/Tailscale"] as const;
const HOST = process.env.CLANKY_EVE_HOST ?? defaultEveHost(PORT);
const BRAIN_AGENT = process.env.CLANKY_BRAIN_AGENT ?? "clanky";
const HERDR = process.env.CLANKY_HERDR_BIN ?? "herdr";
const ENV_PATH = join(REPO, ".env.local");
const DEFAULT_LOCAL_BASE_URL = "http://127.0.0.1:11434/v1";
const DEFAULT_LOCAL_MODEL = "qwen3-coder-next";

function resolvePort(value: string | undefined, fallback: number): number {
	const raw = value?.trim();
	if (raw === undefined || raw.length === 0) return fallback;
	const parsed = Number.parseInt(raw, 10);
	if (!Number.isInteger(parsed) || String(parsed) !== raw || parsed < 1 || parsed > 65_535) {
		throw new Error(`CLANKY_EVE_PORT must be an integer from 1 to 65535; got ${JSON.stringify(value)}`);
	}
	return parsed;
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

async function brainServing(): Promise<boolean> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), 1500);
	try {
		const response = await fetch(`http://127.0.0.1:${PORT}/eve/v1/info`, { signal: controller.signal });
		return response.ok;
	} catch {
		return false;
	} finally {
		clearTimeout(timeout);
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
	child.unref();
}

async function ensureSession(): Promise<SessionEntry> {
	const existing = await sessionRunning();
	if (existing) return existing;
	spawnSessionServer();
	for (let i = 0; i < 20; i++) {
		await sleep(500);
		const found = await sessionRunning();
		if (found) return found;
	}
	throw new Error(`session '${SESSION}' did not start within 10s`);
}

async function findBrain(): Promise<AgentEntry | undefined> {
	return (await listAgents()).find((a) => a.name === BRAIN_AGENT);
}

async function startBrain(): Promise<AgentEntry> {
	const command = await clankyCommandHostCommand();
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
	for (let i = 0; i < 60; i++) {
		await sleep(500);
		if (await brainServing()) {
			const brain = await findBrain();
			if (brain) {
				await waitForCommandHostAttachment(5000);
				return brain;
			}
		}
	}
	throw new Error(`brain '${BRAIN_AGENT}' did not serve on :${PORT} within 30s`);
}

async function clankyCommandHostCommand(): Promise<string[]> {
	const contextTokens = await contextTokensForOwnedBrain();
	return [
		"env",
		`CLANKY_REPO_DIR=${REPO}`,
		`CLANKY_EVE_HOST=${HOST}`,
		...(contextTokens === undefined ? [] : [`${LOCAL_CONTEXT_TOKENS_ENV}=${contextTokens}`]),
		process.execPath,
		"scripts/clanky.ts",
		"--command-host",
	];
}

async function contextTokensForOwnedBrain(): Promise<number | undefined> {
	const env = await readLocalEnv();
	const explicit = parseLocalContextWindowTokens(process.env[LOCAL_CONTEXT_TOKENS_ENV]) ?? parseLocalContextWindowTokens(env[LOCAL_CONTEXT_TOKENS_ENV]);
	if (explicit !== undefined) return explicit;
	const provider = process.env.CLANKY_MODEL_PROVIDER ?? env.CLANKY_MODEL_PROVIDER ?? "codex";
	if (provider !== "local") return undefined;
	return await resolveOllamaContextWindowTokens({
		baseURL: process.env.CLANKY_LOCAL_BASE_URL ?? env.CLANKY_LOCAL_BASE_URL ?? DEFAULT_LOCAL_BASE_URL,
		modelId: process.env.CLANKY_LOCAL_MODEL ?? env.CLANKY_LOCAL_MODEL ?? DEFAULT_LOCAL_MODEL,
	});
}

async function readLocalEnv(): Promise<Record<string, string>> {
	try {
		return parseEnv(await readFile(ENV_PATH, "utf8"));
	} catch {
		return {};
	}
}

async function relayToken(): Promise<string> {
	const fromEnv = process.env.CLANKY_RELAY_TOKEN;
	if (fromEnv !== undefined && fromEnv.trim().length > 0) return fromEnv;
	return (await readLocalEnv()).CLANKY_RELAY_TOKEN ?? "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function relayCommandHostAttached(): Promise<boolean | undefined> {
	const token = await relayToken();
	if (token.trim().length === 0) return undefined;

	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), 1500);
	try {
		const response = await fetch(`http://127.0.0.1:${PORT}/relay/health`, {
			headers: { Authorization: `Bearer ${token}` },
			signal: controller.signal,
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
	} finally {
		clearTimeout(timeout);
	}
}

async function waitForCommandHostAttachment(timeoutMs: number): Promise<boolean> {
	if ((await relayToken()).trim().length === 0) return false;
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const attached = await relayCommandHostAttached();
		if (attached === true) return true;
		await sleep(250);
	}
	return false;
}

async function existingBrainNeedsCommandHostRestart(): Promise<boolean> {
	for (let i = 0; i < 5; i++) {
		const attached = await relayCommandHostAttached();
		if (attached === true || attached === undefined) return false;
		await sleep(500);
	}
	return true;
}

async function waitForBrainPaneGone(paneId: string): Promise<void> {
	for (let i = 0; i < 20; i++) {
		const brain = await findBrain();
		if (brain === undefined || brain.pane_id !== paneId) return;
		await sleep(250);
	}
}

function statusJson(session: SessionEntry | undefined, brain: AgentEntry | undefined, serving: boolean, started: boolean) {
	return {
		ok: !!session && !!brain && serving,
		started,
		session: session ? { name: session.name, socket: session.socket_path } : { name: SESSION, running: false },
		brain: brain ? { agent: brain.name, paneId: brain.pane_id, status: brain.agent_status ?? "unknown" } : null,
		serving,
		relay: { host: HOST, port: PORT, url: `http://${HOST}:${PORT}` },
	};
}

async function runUp(): Promise<number> {
	const session = await ensureSession();
	let brain = await findBrain();
	let started = false;
	let serving = await brainServing();
	if (brain && serving && await existingBrainNeedsCommandHostRestart()) {
		await herdr(["--session", SESSION, "pane", "close", brain.pane_id]);
		await waitForBrainPaneGone(brain.pane_id);
		brain = undefined;
		serving = await brainServing();
	}
	if (brain && !serving) {
		await herdr(["--session", SESSION, "pane", "close", brain.pane_id]);
		await waitForBrainPaneGone(brain.pane_id);
		brain = undefined;
	}
	if (!brain || !serving) {
		brain = await startBrain();
		started = true;
	}
	serving = await brainServing();
	await waitForCommandHostAttachment(2000);
	process.stdout.write(`${JSON.stringify(statusJson(session, brain, serving, started))}\n`);
	return serving ? 0 : 1;
}

async function runStatus(): Promise<number> {
	const session = await sessionRunning();
	const brain = session ? await findBrain() : undefined;
	const serving = session ? await brainServing() : false;
	process.stdout.write(`${JSON.stringify(statusJson(session, brain, serving, false))}\n`);
	return 0;
}

async function runDown(): Promise<number> {
	const session = await sessionRunning();
	const brain = session ? await findBrain() : undefined;
	if (brain) await herdr(["--session", SESSION, "pane", "close", brain.pane_id]);
	process.stdout.write(`${JSON.stringify({ ok: true, closed: brain?.pane_id ?? null })}\n`);
	return 0;
}

const mode: Mode = (process.argv.find((a) => a === "status" || a === "down") as Mode) ?? "up";
const run = mode === "status" ? runStatus : mode === "down" ? runDown : runUp;
run()
	.then((code) => process.exit(code))
	.catch((error: unknown) => {
		process.stdout.write(`${JSON.stringify({ ok: false, error: (error as Error).message })}\n`);
		process.exit(1);
	});
