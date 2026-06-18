/**
 * Clanky's custom face (SPEC.md §4.2 / open decision "face surface").
 *
 * eve's dev TUI has a fixed, non-extensible slash-command set, so this is our
 * own face built on the public eve/client: it owns a headless `eve dev --no-ui`
 * server child (the brain — same sessions, memory, tools), streams turns, and
 * renders them closely mirroring eve dev's look (gutter glyphs, one-line tool
 * summaries, dim status line). On top of that it adds the slash commands eve
 * can't: /token, /model (+ /new /status /help /exit). Config commands rewrite
 * .env.local and restart the brain.
 *
 * Run: pnpm face   (CLANKY_EVE_PORT to change the port, default 2000)
 */
import { type ChildProcess, spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { emitKeypressEvents, type Key } from "node:readline";
import { Client, type ClientSession } from "eve/client";
import type { HandleMessageStreamEvent } from "eve/client";
import { applyEnvUpserts } from "../agent/lib/discord/env-file.ts";

// --- theme (ported from eve's tui/theme.js) ------------------------------
const wrap = (open: number, close: number) => (s: string) => `\x1b[${open}m${s}\x1b[${close}m`;
const C = {
	reset: wrap(0, 0),
	bold: wrap(1, 22),
	dim: wrap(2, 22),
	italic: wrap(3, 23),
	white: wrap(97, 39),
	gray: wrap(90, 39),
	cyan: wrap(36, 39),
	green: wrap(32, 39),
	red: wrap(31, 39),
	yellow: wrap(33, 39),
	orange: (s: string) => `\x1b[38;5;208m${s}\x1b[39m`,
};
const G = {
	brand: "▲",
	user: "▌",
	reasoning: "○",
	success: "✓",
	error: "⨯",
	warning: "⚠",
	elbow: "⎿",
	dot: "·",
	arrow: "→",
	prompt: "❯",
	up: "↑",
	down: "↓",
};

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

const REPO = process.env.CLANKY_REPO_DIR ?? process.cwd();
const PORT = Number.parseInt(process.env.CLANKY_EVE_PORT ?? "2000", 10);
const HOST = `http://127.0.0.1:${PORT}`;
const out = (s: string) => process.stdout.write(s);

/** Animated "thinking…" spinner on the current line; clear() erases it (idempotent). */
function startSpinner(): { clear: () => void } {
	let i = 0;
	let active = true;
	out(`${C.yellow(SPINNER[0] ?? "")} ${C.dim("thinking…")}`);
	const timer = setInterval(() => {
		i = (i + 1) % SPINNER.length;
		out(`\r${C.yellow(SPINNER[i] ?? "")} ${C.dim("thinking…")}`);
	}, 80);
	return {
		clear: () => {
			if (!active) return;
			active = false;
			clearInterval(timer);
			out("\r\x1b[2K");
		},
	};
}

// --- server child (the brain) --------------------------------------------
// eve enforces one dev server per agent, so attach to a running one if present
// and only spawn (and own) our own headless brain when none is up.
let server: ChildProcess | null = null;
let ownsServer = false;

// "healthy" = ready (200); "reachable" = something is listening but not ready
// (e.g. eve dev's 503 "unavailable"); "down" = nothing on the port.
async function probe(): Promise<"healthy" | "reachable" | "down"> {
	try {
		return (await fetch(`${HOST}/eve/v1/info`)).ok ? "healthy" : "reachable";
	} catch {
		return "down";
	}
}

function startServer(): void {
	server = spawn(join(REPO, "node_modules", ".bin", "eve"), ["dev", "--no-ui", "--port", String(PORT)], {
		cwd: REPO,
		env: process.env,
		stdio: ["ignore", "ignore", "ignore"],
	});
}

/**
 * Attach to a running server, or spawn one we own. eve allows one dev server per
 * agent, so when something is already listening we never spawn (it would lose to
 * the pid lock) — we attach, waiting briefly if it is still warming up.
 * Returns true if we spawned (and therefore own) the server.
 */
async function ensureServer(): Promise<boolean> {
	const initial = await probe();
	if (initial === "healthy") return false;
	if (initial === "reachable") {
		out(`  ${C.dim(`a server is on ${HOST} but not ready yet — waiting…`)}\n`);
		const deadline = Date.now() + 20_000;
		while (Date.now() < deadline) {
			await new Promise((r) => setTimeout(r, 800));
			if ((await probe()) === "healthy") return false;
		}
		out(`  ${C.yellow(`${G.warning} ${HOST} is up but unhealthy (503). Restart the eve server that owns it; attaching anyway.`)}\n`);
		return false;
	}
	startServer();
	await waitForHealth();
	return true;
}

async function waitForHealth(timeoutMs = 45_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		try {
			const res = await fetch(`${HOST}/eve/v1/info`);
			if (res.ok) return;
		} catch {
			// not up yet
		}
		if (Date.now() > deadline) throw new Error(`Clanky server did not become healthy on ${HOST}`);
		await new Promise((r) => setTimeout(r, 500));
	}
}

async function stopServer(): Promise<void> {
	const child = server;
	server = null;
	if (child === null || child.killed) return;
	child.kill("SIGTERM");
	await new Promise((r) => setTimeout(r, 300));
}

async function fetchModel(): Promise<string> {
	try {
		const info = (await (await fetch(`${HOST}/eve/v1/info`)).json()) as { agent?: { model?: { id?: string } } };
		return info.agent?.model?.id ?? "(model)";
	} catch {
		return "(model)";
	}
}

// --- rendering (mirrors eve's tui/blocks.js) ------------------------------
interface TurnState {
	wroteAssistant: boolean;
	sawText: boolean;
	inTokens: number;
	outTokens: number;
}

// Stream events that produce visible output (used to stop the spinner).
const VISIBLE_EVENTS = new Set([
	"reasoning.completed",
	"message.appended",
	"message.completed",
	"actions.requested",
	"action.result",
	"turn.failed",
]);

function summarizeArgs(input: unknown): string {
	if (input === null || input === undefined || typeof input !== "object") return "";
	const entries = Object.entries(input as Record<string, unknown>);
	if (entries.length === 0) return "";
	const parts = entries.slice(0, 4).map(([k, v]) => {
		const value = typeof v === "string" ? `"${v.length > 32 ? `${v.slice(0, 31)}…` : v}"` : JSON.stringify(v);
		return `${k}=${value}`;
	});
	const text = parts.join("  ");
	return text.length > 80 ? `${text.slice(0, 79)}…` : text;
}

function renderEvent(ev: HandleMessageStreamEvent, state: TurnState): void {
	switch (ev.type) {
		case "reasoning.completed": {
			const text = ev.data.text?.trim();
			if (text && text.length > 0) out(`\n${C.gray(G.reasoning)} ${C.dim(C.italic(text))}\n`);
			break;
		}
		case "message.appended": {
			if (!state.wroteAssistant) {
				out(`\n${C.bold(C.white(G.brand))} `);
				state.wroteAssistant = true;
			}
			state.sawText = true;
			out(C.white(ev.data.messageDelta));
			break;
		}
		case "message.completed": {
			// Fallback for a reply that arrived without streamed deltas.
			const text = ev.data.message?.trim();
			if (!state.wroteAssistant && text && text.length > 0) {
				out(`\n${C.bold(C.white(G.brand))} ${C.white(text)}`);
				state.wroteAssistant = true;
				state.sawText = true;
			}
			break;
		}
		case "actions.requested": {
			for (const action of ev.data.actions) {
				const a = action as { name?: string; toolName?: string; input?: unknown; arguments?: unknown };
				const name = a.name ?? a.toolName ?? "tool";
				const args = summarizeArgs(a.input ?? a.arguments);
				out(`\n${C.yellow(G.dot)} ${C.bold(name)}${args.length > 0 ? `  ${C.gray(args)}` : ""}`);
			}
			break;
		}
		case "action.result": {
			const failed = ev.data.status === "error" || ev.data.error !== undefined;
			out(`  ${failed ? C.red(G.error) : C.green(G.success)}`);
			break;
		}
		case "step.completed": {
			const usage = (ev.data as { usage?: { inputTokens?: number; outputTokens?: number } }).usage;
			if (usage) {
				state.inTokens += usage.inputTokens ?? 0;
				state.outTokens += usage.outputTokens ?? 0;
			}
			break;
		}
		case "turn.failed": {
			out(`\n${C.red(C.bold(G.error))} ${C.red(ev.data.message ?? "turn failed")}\n`);
			break;
		}
		default:
			break;
	}
}

function statusLine(model: string, state: TurnState): string {
	const sep = `  ${C.dim(G.dot)}  `;
	const tokens = C.dim(`${G.up} ${(state.inTokens / 1000).toFixed(1)}K ${G.down} ${state.outTokens}`);
	return [C.dim(model), tokens, C.dim("External endpoint")].join(sep);
}

// --- slash commands the eve TUI can't have -------------------------------
interface Command {
	name: string;
	aliases: string[];
	argHint: string;
	description: string;
}

const COMMANDS: Command[] = [
	{ name: "token", aliases: [], argHint: "<token> [--user-token] [--voice]", description: "Set the Discord credential + restart" },
	{ name: "model", aliases: [], argHint: "[codex|claude] [id] [effort]", description: "Switch the conductor model + restart" },
	{ name: "effort", aliases: [], argHint: "[minimal|low|medium|high|xhigh]", description: "Set Codex reasoning effort + restart" },
	{ name: "status", aliases: [], argHint: "", description: "Gateway + model status" },
	{ name: "new", aliases: [], argHint: "", description: "Start a fresh session" },
	{ name: "help", aliases: [], argHint: "", description: "Show available commands" },
	{ name: "exit", aliases: ["quit"], argHint: "", description: "Quit the face" },
];

const EFFORT_LEVELS = ["minimal", "low", "medium", "high", "xhigh"];
const EFFORT_OPTIONS: MenuOption[] = [
	{ label: "minimal", hint: "fastest" },
	{ label: "low" },
	{ label: "medium" },
	{ label: "high" },
	{ label: "xhigh", hint: "deepest" },
	{ label: "keep current" },
];

function helpText(): string {
	const width = Math.max(...COMMANDS.map((c) => `/${c.name} ${c.argHint}`.length)) + 2;
	const rows = COMMANDS.map((c) => {
		const invocation = `/${c.name}${c.argHint.length > 0 ? ` ${c.argHint}` : ""}`;
		return `  ${C.cyan(`/${c.name}`)}${C.dim(invocation.slice(`/${c.name}`.length))}${" ".repeat(width - invocation.length)}${C.dim(c.description)}`;
	});
	return [C.bold("Clanky commands"), ...rows, C.dim("Everything else is a message to Clanky.")].join("\n");
}

const envPath = join(REPO, ".env.local");

async function writeEnv(updates: Record<string, string>): Promise<void> {
	const existing = await readFile(envPath, "utf8").catch(() => "");
	await writeFile(envPath, applyEnvUpserts(existing, updates), "utf8");
}

async function restartBrain(): Promise<void> {
	if (!ownsServer) {
		out(`  ${C.dim(`saved .env.local ${G.dot} attached to an external eve server — restart it to apply`)}\n`);
		return;
	}
	out(`  ${C.dim(`saved .env.local ${G.dot} restarting Clanky…`)}\n`);
	await stopServer();
	startServer();
	await waitForHealth();
	out(`  ${C.dim("ready")}\n`);
}

/** Returns the (possibly new) session, or null to exit. */
async function handleCommand(line: string, client: Client, session: ClientSession): Promise<ClientSession | null> {
	const [cmd, ...rest] = line.slice(1).split(/\s+/);
	switch (cmd) {
		case "exit":
		case "quit":
			return null;
		case "help":
			out(`${helpText()}\n`);
			return session;
		case "new":
			out(`  ${C.dim("new session")}\n`);
			return client.session();
		case "status": {
			const model = await fetchModel();
			const health = await fetch(`${HOST}/discord-gateway/health`)
				.then((r) => r.json())
				.catch(() => ({ running: false }));
			out(`  ${C.dim(`model: ${model}`)}\n  ${C.dim(`discord gateway: ${JSON.stringify(health)}`)}\n`);
			return session;
		}
		case "token": {
			const token = rest.find((a) => !a.startsWith("--"));
			if (token === undefined) {
				out(`  ${C.red("usage: /token <token> [--user-token] [--voice]")}\n`);
				return session;
			}
			const updates: Record<string, string> = {
				DISCORD_BOT_TOKEN: token,
				CLANKY_DISCORD_CREDENTIAL_KIND: rest.includes("--user-token") ? "user-token" : "bot-token",
				CLANKY_DISCORD_PRESENCE: "1",
			};
			if (rest.includes("--voice")) updates.CLANKY_DISCORD_VOICE = "1";
			await writeEnv(updates);
			await restartBrain();
			return client.session();
		}
		case "model": {
			let provider = rest[0];
			let modelId = rest[1];
			let effort = rest[2];
			if (provider !== "codex" && provider !== "claude") {
				const p = await selectMenu("Configure model — provider", [
					{ label: "codex", hint: "OpenAI ChatGPT subscription" },
					{ label: "claude", hint: "Claude Pro/Max subscription" },
				]);
				if (p === null) {
					out(`  ${C.dim("cancelled")}\n`);
					return session;
				}
				provider = p === 0 ? "codex" : "claude";
				const choices =
					provider === "codex"
						? [{ label: "gpt-5.5" }, { label: "gpt-5.4" }, { label: "gpt-5.3-codex-spark" }, { label: "keep current" }]
						: [{ label: "claude-sonnet-4-6" }, { label: "claude-opus-4-8" }, { label: "keep current" }];
				const m = await selectMenu(`Configure model — ${provider}`, choices);
				if (m === null) {
					out(`  ${C.dim("cancelled")}\n`);
					return session;
				}
				const chosen = choices[m]?.label;
				modelId = chosen === "keep current" ? undefined : chosen;
				if (provider === "codex") {
					const e = await selectMenu("Reasoning effort", EFFORT_OPTIONS);
					if (e === null) {
						out(`  ${C.dim("cancelled")}\n`);
						return session;
					}
					const chosenEffort = EFFORT_OPTIONS[e]?.label;
					effort = chosenEffort === "keep current" ? undefined : chosenEffort;
				}
			}
			const updates: Record<string, string> = { CLANKY_MODEL_PROVIDER: provider };
			if (modelId) updates[provider === "claude" ? "CLANKY_CLAUDE_MODEL" : "CLANKY_CODEX_MODEL"] = modelId;
			if (effort && provider === "codex") updates.CLANKY_CODEX_EFFORT = effort;
			await writeEnv(updates);
			await restartBrain();
			return client.session();
		}
		case "effort": {
			let effort = rest[0];
			if (!EFFORT_LEVELS.includes(effort ?? "")) {
				const e = await selectMenu("Codex reasoning effort", EFFORT_OPTIONS);
				if (e === null) {
					out(`  ${C.dim("cancelled")}\n`);
					return session;
				}
				const chosen = EFFORT_OPTIONS[e]?.label;
				if (chosen === "keep current" || chosen === undefined) return session;
				effort = chosen;
			}
			await writeEnv({ CLANKY_CODEX_EFFORT: effort });
			await restartBrain();
			return client.session();
		}
		default:
			out(`  ${C.red(`unknown command /${cmd}`)} ${C.dim("(/help)")}\n`);
			return session;
	}
}

// --- main loop -----------------------------------------------------------
function banner(model: string): void {
	out(`\n ${C.bold(C.white(G.brand))} ${C.bold("Clanky")}  ${C.dim(model)}\n`);
	out(` ${C.dim("Custom face on eve/client. Type /help for commands.")}\n\n`);
}

out(`${C.dim("starting Clanky…")}\n`);
ownsServer = await ensureServer();
const client = new Client({ host: HOST });
let session = client.session();
const model = await fetchModel();
banner(model);

// --- interactive selection menu (mirrors eve's "↑/↓ move" panels) --------
interface MenuOption {
	label: string;
	hint?: string;
}

/** Arrow-navigable menu. Resolves the chosen index, or null on esc. */
async function selectMenu(title: string, options: MenuOption[]): Promise<number | null> {
	return new Promise((resolve) => {
		let sel = 0;
		out("\n");

		const lines = (): string[] => {
			const rows = options.map((o, i) => {
				const ptr = i === sel ? C.cyan(G.prompt) : " ";
				const label = i === sel ? C.bold(C.white(o.label)) : o.label;
				return `${ptr} ${label}${o.hint ? `  ${C.dim(o.hint)}` : ""}`;
			});
			return [C.bold(title), ...rows, C.dim(`${G.up}/${G.down} move ${G.dot} enter to select ${G.dot} esc to cancel`)];
		};

		const draw = () => {
			const body = lines();
			out("\r\x1b[0J");
			out(body.join("\n"));
			out(`\x1b[${body.length - 1}A\r`);
		};

		const finish = (value: number | null) => {
			out("\r\x1b[0J");
			process.stdin.off("keypress", onKey);
			process.stdin.setRawMode(false);
			process.stdin.pause();
			resolve(value);
		};

		const onKey = (_str: string | undefined, key: Key) => {
			if (key.ctrl && key.name === "c") {
				out("\n");
				void (ownsServer ? stopServer() : Promise.resolve()).then(() => process.exit(0));
				return;
			}
			if (key.name === "up") sel = (sel - 1 + options.length) % options.length;
			else if (key.name === "down") sel = (sel + 1) % options.length;
			else if (key.name === "return") return finish(sel);
			else if (key.name === "escape") return finish(null);
			else return;
			draw();
		};

		process.stdin.setRawMode(true);
		process.stdin.resume();
		process.stdin.on("keypress", onKey);
		draw();
	});
}

// --- raw-mode line editor with slash typeahead (mirrors eve's TUI) --------
function matchingCommands(text: string): Command[] {
	if (!text.startsWith("/") || /\s/.test(text)) return [];
	const q = text.slice(1);
	return COMMANDS.filter((c) => [c.name, ...c.aliases].some((n) => n.startsWith(q)));
}

/** The command whose name/alias the text exactly equals (eve shows its hint inline). */
function exactCommand(text: string): Command | undefined {
	const matches = matchingCommands(text);
	if (matches.length !== 1) return undefined;
	const q = text.slice(1);
	const c = matches[0];
	return c !== undefined && [c.name, ...c.aliases].includes(q) ? c : undefined;
}

function renderMenu(matches: Command[], selected: number): string[] {
	const view = matches.slice(0, 10);
	const width = Math.max(...view.map((c) => `/${c.name}${c.aliases.map((a) => ` (/${a})`).join("")}`.length)) + 2;
	return view.map((c, i) => {
		const invocation = `/${c.name}${c.aliases.map((a) => ` (/${a})`).join("")}`;
		const ptr = i === selected ? C.cyan(G.prompt) : " ";
		const name = i === selected ? `\x1b[34m/${c.name}\x1b[39m` : `/${c.name}`;
		const pad = " ".repeat(width - invocation.length);
		return `${ptr} ${name}${C.dim(invocation.slice(`/${c.name}`.length))}${pad}${C.dim(c.description)}`;
	});
}

async function prompt(): Promise<string> {
	return new Promise((resolve) => {
		let text = "";
		let cursor = 0;
		let selected = 0;
		let menuRows = 0;

		const draw = () => {
			// The cursor is parked on the prompt line between draws; clear it and
			// everything below, then repaint.
			out("\r\x1b[0J");
			const matches = matchingCommands(text);
			const exact = exactCommand(text);
			// On an exact command match show the arg hint inline (like eve) and
			// suppress the dropdown; otherwise show the dropdown of matches.
			const inline = exact !== undefined && exact.argHint.length > 0 ? ` ${C.dim(exact.argHint)}` : "";
			out(`${C.cyan(G.prompt)} ${text}${inline}`);
			if (selected >= matches.length) selected = 0;
			const menu = matches.length > 0 && exact === undefined ? renderMenu(matches, selected) : [];
			menuRows = menu.length;
			if (menuRows > 0) out(`\n${menu.join("\n")}`);
			if (menuRows > 0) out(`\x1b[${menuRows}A`);
			// Park the cursor at the edit position on the prompt line (before the hint).
			out(`\r\x1b[${2 + cursor}C`);
		};

		const finish = (value: string) => {
			out("\r\x1b[0J");
			process.stdin.off("keypress", onKey);
			process.stdin.setRawMode(false);
			process.stdin.pause();
			resolve(value);
		};

		const onKey = (str: string | undefined, key: Key) => {
			const matches = matchingCommands(text);
			const dropdownOpen = matches.length > 0 && exactCommand(text) === undefined;
			if (key.ctrl && key.name === "c") {
				out("\n");
				void (ownsServer ? stopServer() : Promise.resolve()).then(() => process.exit(0));
				return;
			}
			if (key.name === "return") {
				finish(text.trim());
				return;
			}
			if (key.name === "tab" && matches.length > 0) {
				const c = matches[dropdownOpen ? selected : 0];
				if (c !== undefined) {
					text = `/${c.name}${c.argHint.length > 0 ? " " : ""}`;
					cursor = text.length;
				}
			} else if ((key.name === "up" || key.name === "down") && dropdownOpen) {
				selected = (selected + (key.name === "down" ? 1 : -1) + matches.length) % matches.length;
			} else if (key.name === "backspace") {
				if (cursor > 0) {
					text = text.slice(0, cursor - 1) + text.slice(cursor);
					cursor -= 1;
				}
			} else if (key.name === "left") {
				cursor = Math.max(0, cursor - 1);
			} else if (key.name === "right") {
				cursor = Math.min(text.length, cursor + 1);
			} else if (key.ctrl && key.name === "a") {
				cursor = 0;
			} else if (key.ctrl && key.name === "e") {
				cursor = text.length;
			} else if (key.ctrl && key.name === "u") {
				text = text.slice(cursor);
				cursor = 0;
			} else if (str !== undefined && str.length === 1 && !key.ctrl && !key.meta && str >= " ") {
				text = text.slice(0, cursor) + str + text.slice(cursor);
				cursor += 1;
			}
			draw();
		};

		process.stdin.setRawMode(true);
		process.stdin.resume();
		process.stdin.on("keypress", onKey);
		draw();
	});
}

emitKeypressEvents(process.stdin);

for (;;) {
	const line = (await prompt()).trim();
	if (line.length === 0) continue;
	// Render the input as an eve-style user block (slash commands in blue).
	out(`${C.cyan(G.user)} ${line.startsWith("/") ? `\x1b[34m${line}\x1b[39m` : line}\n`);
	if (line.startsWith("/")) {
		const next = await handleCommand(line, client, session);
		if (next === null) break;
		session = next;
		continue;
	}
	const state: TurnState = { wroteAssistant: false, sawText: false, inTokens: 0, outTokens: 0 };
	const spinner = startSpinner();
	let cleared = false;
	try {
		const response = await session.send(line);
		for await (const ev of response) {
			if (!cleared && VISIBLE_EVENTS.has(ev.type)) {
				spinner.clear();
				cleared = true;
			}
			renderEvent(ev, state);
		}
		spinner.clear();
		// Make a silent turn legible: the model may have only run tools (or nothing).
		if (!state.sawText) out(`\n${C.dim("(no reply — see tool calls above)")}`);
		out(`\n${statusLine(await fetchModel(), state)}\n`);
	} catch (error) {
		spinner.clear();
		out(`\n${C.red(C.bold(G.error))} ${C.red((error as Error).message)}\n`);
	}
}

if (ownsServer) await stopServer();
process.exit(0);
