/**
 * Clanky lifecycle helper — the SSH cold-start seam for the iOS app (SPEC.md §5.1).
 *
 * The iOS app reaches the Mac over the tailnet via SSH and runs this script.
 * It is the one process that exists *below* Clanky: the relay channel lives
 * inside the eve brain, so it cannot start the brain. This can.
 *
 * It is idempotent. `up` ensures the persistent herdr session exists and that
 * Clanky's brain (`eve dev --no-ui`) is running as a pane inside it, then prints
 * a JSON status. `status` reports without starting. `down` closes the brain pane.
 *
 * Run over SSH, e.g.:
 *   ssh mac 'cd ~/dev/clanky-eve-herdr && bash -lc "node scripts/clanky-up.ts --json"'
 *
 * Env:
 *   CLANKY_SESSION     herdr session name (default "clankies")
 *   CLANKY_REPO_DIR    repo dir for the brain pane cwd (default process.cwd())
 *   CLANKY_EVE_PORT    relay/eve port (default 2000)
 *   CLANKY_EVE_HOST    eve bind host (default "0.0.0.0"; bind the tailscale IP
 *                      for stricter exposure — the relay is bearer-gated anyway)
 *   CLANKY_BRAIN_AGENT herdr agent name for the brain pane (default "clanky")
 *   CLANKY_HERDR_BIN   herdr binary (default "herdr" on PATH)
 */
import { spawn } from "node:child_process";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { join } from "node:path";
import { parseEnv } from "node:util";
import {
	LOCAL_CONTEXT_TOKENS_ENV,
	parseLocalContextWindowTokens,
	resolveOllamaContextWindowTokens,
} from "../agent/lib/local-context.ts";

const SESSION = process.env.CLANKY_SESSION ?? "clankies";
const REPO = process.env.CLANKY_REPO_DIR ?? process.cwd();
const PORT = resolvePort(process.env.CLANKY_EVE_PORT, 2000);
const HOST = process.env.CLANKY_EVE_HOST ?? "0.0.0.0";
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

// Resolve TCP reachability of the eve port, the real "brain is serving" signal.
function portOpen(): Promise<boolean> {
	return new Promise((resolve) => {
		const socket = createConnection({ host: "127.0.0.1", port: PORT });
		const done = (open: boolean) => {
			socket.destroy();
			resolve(open);
		};
		socket.setTimeout(1500, () => done(false));
		socket.on("connect", () => done(true));
		socket.on("error", () => done(false));
	});
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
	const command = await eveDevCommand();
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
		if (await portOpen()) {
			const brain = await findBrain();
			if (brain) return brain;
		}
	}
	throw new Error(`brain '${BRAIN_AGENT}' did not serve on :${PORT} within 30s`);
}

async function eveDevCommand(): Promise<string[]> {
	const command = ["pnpm", "exec", "eve", "dev", "--no-ui", "--host", HOST, "--port", String(PORT)];
	const contextTokens = await contextTokensForOwnedBrain();
	return contextTokens === undefined ? command : ["env", `${LOCAL_CONTEXT_TOKENS_ENV}=${contextTokens}`, ...command];
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
	if (!brain || !(await portOpen())) {
		brain = await startBrain();
		started = true;
	}
	const serving = await portOpen();
	process.stdout.write(`${JSON.stringify(statusJson(session, brain, serving, started))}\n`);
	return serving ? 0 : 1;
}

async function runStatus(): Promise<number> {
	const session = await sessionRunning();
	const brain = session ? await findBrain() : undefined;
	const serving = session ? await portOpen() : false;
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
