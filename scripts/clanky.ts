/**
 * Clanky's custom face (SPEC.md §4.2).
 *
 * The face owns Clanky-specific slash commands and server lifecycle, then
 * delegates rendering, input editing, HITL, subagents, connection auth, logs,
 * status lines, and stream translation to eve's dev TUI runner/renderer.
 *
 * Run: pnpm face   (CLANKY_EVE_PORT to change the port, default 2000)
 */
import { type ChildProcess, execFile, spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { Client } from "eve/client";
import {
	EveTUIRunner,
	type PromptCommandHandler,
	type PromptCommandHandlerContext,
	type PromptCommandOutcome,
} from "../node_modules/eve/dist/src/cli/dev/tui/runner.js";
import {
	TerminalRenderer,
	type TerminalOutput,
} from "../node_modules/eve/dist/src/cli/dev/tui/terminal-renderer.js";
import {
	PROMPT_COMMANDS,
	type PromptCommand,
	type PromptCommandSpec,
} from "../node_modules/eve/dist/src/cli/dev/tui/prompt-commands.js";
import type { SetupFlowRenderer } from "../node_modules/eve/dist/src/cli/dev/tui/setup-flow.js";
import { applyEnvUpserts } from "../agent/lib/discord/env-file.ts";

const REPO = process.env.CLANKY_REPO_DIR ?? process.cwd();
const PORT = Number.parseInt(process.env.CLANKY_EVE_PORT ?? "2000", 10);
const HOST = `http://127.0.0.1:${PORT}`;
const ENV_PATH = join(REPO, ".env.local");
const CLANKY_HEADER_NOTE = "Clanky face on eve/client. Type /help for commands.";
const runHostCommand = promisify(execFile);

type ClankyExtensionCommandName = "discord-token" | "model" | "effort" | "status";
type ClankyExtensionCommand = {
	type: "extension";
	name: ClankyExtensionCommandName;
	argument: string;
};
type ClankyPromptCommand = PromptCommand | ClankyExtensionCommand;
type ClankyPromptCommandSpec = Omit<PromptCommandSpec, "build"> & {
	readonly build: (argument: string) => ClankyPromptCommand;
};

type ClankyConfig = {
	provider: "codex" | "claude";
	codexModel?: string;
	claudeModel?: string;
	codexEffort?: string;
};

type MenuOption = {
	value: string;
	label: string;
	hint?: string;
	description?: string;
};

const EFFORT_LEVELS = ["minimal", "low", "medium", "high", "xhigh"] as const;
const MODEL_OPTIONS: Record<ClankyConfig["provider"], readonly MenuOption[]> = {
	codex: [
		{ value: "gpt-5.5", label: "gpt-5.5" },
		{ value: "gpt-5.4", label: "gpt-5.4" },
		{ value: "gpt-5.3-codex-spark", label: "gpt-5.3-codex-spark" },
		{ value: "keep-current", label: "keep current" },
	],
	claude: [
		{ value: "claude-sonnet-4-6", label: "claude-sonnet-4-6" },
		{ value: "claude-opus-4-8", label: "claude-opus-4-8" },
		{ value: "keep-current", label: "keep current" },
	],
};
const EFFORT_OPTIONS: readonly MenuOption[] = [
	{ value: "minimal", label: "minimal", hint: "fastest" },
	{ value: "low", label: "low" },
	{ value: "medium", label: "medium" },
	{ value: "high", label: "high" },
	{ value: "xhigh", label: "xhigh", hint: "deepest" },
	{ value: "keep-current", label: "keep current" },
];

let server: ChildProcess | null = null;
let ownsServer = false;
let terminalReady = false;
let forwardServerOutput = false;

installClankyPromptCommands();

process.stdout.write("\x1b[2mstarting Clanky...\x1b[22m\n");
await reportClankyFaceToHerdr("working", "starting Clanky face");
ownsServer = await ensureServer();
await reportClankyFaceToHerdr("idle", "Clanky face ready");

const client = new Client({ host: HOST });
const renderer = new TerminalRenderer({
	output: createClankyOutput(process.stdout),
	captureForeignOutput: true,
});
gateServerOutputUntilHeader(renderer);
const runner = new EveTUIRunner({
	name: "Clanky",
	session: client.session(),
	client,
	renderer,
	serverUrl: HOST,
	promptCommandHandler: createClankyCommandHandler(),
});

try {
	await runner.run();
} finally {
	await reportClankyFaceToHerdr("unknown", "Clanky face stopped");
	if (ownsServer) await stopServer();
}

function installClankyPromptCommands(): void {
	const registry = PROMPT_COMMANDS as unknown as ClankyPromptCommandSpec[];
	registry.splice(
		0,
		registry.length,
		{
			name: "help",
			aliases: [],
			description: "Show available commands",
			takesArgument: false,
			build: () => ({ type: "help" }),
		},
		{
			name: "new",
			aliases: [],
			description: "Start a fresh session",
			takesArgument: false,
			build: () => ({ type: "new" }),
		},
		{
			name: "discord-token",
			aliases: ["token"],
			description: "Set the Discord credential and restart Clanky",
			argumentHint: "<token> [--user-token] [--voice]",
			takesArgument: true,
			build: (argument) => ({ type: "extension", name: "discord-token", argument }),
		},
		{
			name: "model",
			aliases: [],
			description: "Configure Codex or Claude subscription-backed model",
			argumentHint: "[codex|claude] [id] [effort]",
			takesArgument: true,
			build: (argument) => ({ type: "extension", name: "model", argument }),
		},
		{
			name: "effort",
			aliases: [],
			description: "Set Codex reasoning effort",
			argumentHint: "[minimal|low|medium|high|xhigh]",
			takesArgument: true,
			build: (argument) => ({ type: "extension", name: "effort", argument }),
		},
		{
			name: "status",
			aliases: [],
			description: "Show model and Discord gateway status",
			takesArgument: false,
			build: (argument) => ({ type: "extension", name: "status", argument }),
		},
		{
			name: "loglevel",
			aliases: [],
			description: "Show or hide captured stdout/stderr/sandbox logs",
			argumentHint: "[all|stderr|sandbox|none]",
			takesArgument: true,
			build: (argument) => ({ type: "loglevel", argument }),
		},
		{
			name: "exit",
			aliases: ["quit"],
			description: "Quit the face",
			takesArgument: false,
			build: () => ({ type: "exit" }),
		},
	);
}

function createClankyOutput(output: NodeJS.WriteStream): TerminalOutput {
	const write = output.write.bind(output);
	return {
		get isTTY() {
			return output.isTTY;
		},
		get columns() {
			return output.columns;
		},
		get rows() {
			return output.rows;
		},
		write(
			chunk: string | Uint8Array,
			encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
			callback?: (error?: Error | null) => void,
		): boolean {
			const next = typeof chunk === "string" ? rewriteHeader(chunk) : chunk;
			if (typeof encodingOrCallback === "function") return write(next, encodingOrCallback);
			if (encodingOrCallback !== undefined) return write(next, encodingOrCallback, callback);
			return write(next);
		},
		on(event: "resize", listener: () => void): TerminalOutput {
			output.on(event, listener);
			return this;
		},
		off(event: "resize", listener: () => void): TerminalOutput {
			output.off(event, listener);
			return this;
		},
	};
}

function gateServerOutputUntilHeader(renderer: TerminalRenderer): void {
	const renderAgentHeader = renderer.renderAgentHeader.bind(renderer);
	renderer.renderAgentHeader = (options) => {
		renderAgentHeader(options);
		terminalReady = true;
		forwardServerOutput = server !== null;
	};
}

async function reportClankyFaceToHerdr(state: "idle" | "working" | "blocked" | "unknown", message: string): Promise<void> {
	if (process.env.HERDR_ENV !== "1") return;
	const paneId = process.env.HERDR_PANE_ID;
	if (paneId === undefined || paneId.length === 0) return;
	await runHostCommand("herdr", [
		"pane",
		"report-agent",
		paneId,
		"--source",
		"clanky-face",
		"--agent",
		"clanky:main",
		"--state",
		state,
		"--message",
		message,
	]).catch(() => {});
}

function rewriteHeader(chunk: string): string {
	return chunk
		.replace("\x1b[1meve\x1b[22m \x1b[2mClanky\x1b[22m", "\x1b[1mClanky\x1b[22m \x1b[2meve-backed face\x1b[22m")
		.replace("eve Clanky", "Clanky eve-backed face")
		.replace(/Public preview: https:\/\/vercel\.com\/docs\/release-phases\/[^\x1b\r\n]*/g, CLANKY_HEADER_NOTE)
		.replace(/eve is currently in preview: https:\/\/vercel\.com\/docs\/release-phases\/[^\x1b\r\n]*/g, CLANKY_HEADER_NOTE);
}

function createClankyCommandHandler(): PromptCommandHandler {
	const handler = {
		async handle(
			command: ClankyExtensionCommand,
			context: PromptCommandHandlerContext,
		): Promise<PromptCommandOutcome> {
			switch (command.name) {
				case "discord-token":
					return { message: await setDiscordToken(command.argument) };
				case "model":
					return { message: await configureModel(command.argument, context.renderer.setupFlow) };
				case "effort":
					return { message: await configureEffort(command.argument, context.renderer.setupFlow) };
				case "status":
					return { message: await statusText() };
			}
		},
	};
	return handler as unknown as PromptCommandHandler;
}

async function setDiscordToken(argument: string): Promise<string> {
	const args = splitArgs(argument);
	const token = args.find((arg) => !arg.startsWith("--"));
	if (token === undefined) {
		return "Usage: /discord-token <token> [--user-token] [--voice]";
	}

	const updates: Record<string, string> = {
		DISCORD_BOT_TOKEN: token,
		CLANKY_DISCORD_CREDENTIAL_KIND: args.includes("--user-token") ? "user-token" : "bot-token",
		CLANKY_DISCORD_PRESENCE: "1",
	};
	if (args.includes("--voice")) updates.CLANKY_DISCORD_VOICE = "1";

	await writeEnv(updates);
	return await restartBrainMessage("Discord credential saved");
}

async function configureModel(argument: string, flow: SetupFlowRenderer | undefined): Promise<string> {
	const args = splitArgs(argument);
	const existing = await readConfig();
	let provider = parseProvider(args[0]);
	let modelId = provider === undefined ? undefined : args[1];
	let effort = provider === undefined ? undefined : args[2];

	if (provider === undefined && args.length > 0) {
		return `Unknown model provider "${args[0]}". Use codex or claude.`;
	}

	if (provider === undefined) {
		if (flow === undefined) return "Usage: /model [codex|claude] [id] [effort]";
		provider = await selectProvider(flow, existing.provider);
		if (provider === undefined) return "/model cancelled.";
		modelId = await selectModel(flow, provider, existing);
		if (modelId === undefined) return "/model cancelled.";
		if (modelId === "keep-current") modelId = undefined;
		if (provider === "codex") {
			effort = await selectEffort(flow, existing.codexEffort);
			if (effort === undefined) return "/model cancelled.";
			if (effort === "keep-current") effort = undefined;
		}
	}

	const updates: Record<string, string> = { CLANKY_MODEL_PROVIDER: provider };
	if (modelId !== undefined && modelId.length > 0) {
		updates[provider === "claude" ? "CLANKY_CLAUDE_MODEL" : "CLANKY_CODEX_MODEL"] = modelId;
	}
	if (provider === "codex" && effort !== undefined && effort.length > 0) {
		if (!isEffortLevel(effort)) return `Unknown Codex effort "${effort}".`;
		updates.CLANKY_CODEX_EFFORT = effort;
	}

	await writeEnv(updates);
	return await restartBrainMessage(`Model provider set to ${provider}${modelId ? ` (${modelId})` : ""}`);
}

async function configureEffort(argument: string, flow: SetupFlowRenderer | undefined): Promise<string> {
	let effort: string | undefined = splitArgs(argument)[0];
	if (effort === undefined || !isEffortLevel(effort)) {
		if (argument.trim().length > 0) return `Unknown Codex effort "${argument.trim()}".`;
		if (flow === undefined) return "Usage: /effort [minimal|low|medium|high|xhigh]";
		const existing = await readConfig();
		effort = await selectEffort(flow, existing.codexEffort);
		if (effort === undefined || effort === "keep-current") return "/effort cancelled.";
	}

	await writeEnv({ CLANKY_CODEX_EFFORT: effort });
	return await restartBrainMessage(`Codex reasoning effort set to ${effort}`);
}

async function statusText(): Promise<string> {
	const [info, gateway] = await Promise.all([fetchInfo(), fetchDiscordGatewayHealth()]);
	const config = await readConfig();
	const model = info?.agent?.model?.id ?? "(model unknown)";
	const lines = [
		`model: ${model}`,
		`provider: ${config.provider}${config.provider === "codex" && config.codexEffort ? ` (${config.codexEffort})` : ""}`,
		`discord gateway: ${formatJson(gateway)}`,
	];
	return lines.join("\n");
}

async function selectProvider(
	flow: SetupFlowRenderer,
	initialValue: ClankyConfig["provider"],
): Promise<ClankyConfig["provider"] | undefined> {
	flow.begin("Configure Clanky model");
	try {
		const selected = await selectOne(
			flow,
			"Choose the subscription provider Clanky should use.",
			[
				{
					value: "codex",
					label: "codex",
					hint: "OpenAI ChatGPT subscription",
				},
				{
					value: "claude",
					label: "claude",
					hint: "Claude Pro/Max subscription",
				},
			],
			initialValue,
		);
		return parseProvider(selected);
	} finally {
		flow.end({ preserveDiagnostics: false });
	}
}

async function selectModel(
	flow: SetupFlowRenderer,
	provider: ClankyConfig["provider"],
	config: ClankyConfig,
): Promise<string | undefined> {
	flow.begin(`Configure ${provider} model`);
	try {
		const current = provider === "codex" ? config.codexModel : config.claudeModel;
		return await selectOne(flow, "Choose the model Clanky should use.", MODEL_OPTIONS[provider], current);
	} finally {
		flow.end({ preserveDiagnostics: false });
	}
}

async function selectEffort(
	flow: SetupFlowRenderer,
	currentEffort: string | undefined,
): Promise<string | undefined> {
	flow.begin("Configure Codex reasoning effort");
	try {
		return await selectOne(flow, "Choose the Codex reasoning effort.", EFFORT_OPTIONS, currentEffort);
	} finally {
		flow.end({ preserveDiagnostics: false });
	}
}

async function selectOne(
	flow: SetupFlowRenderer,
	message: string,
	options: readonly MenuOption[],
	initialValue: string | undefined,
): Promise<string | undefined> {
	const selected = await flow.readSelect({
		kind: "single",
		message,
		options,
		initialValue,
	});
	return selected?.[0];
}

async function readConfig(): Promise<ClankyConfig> {
	const content = await readFile(ENV_PATH, "utf8").catch(() => "");
	const get = (key: string): string | undefined => {
		for (const raw of content.split("\n")) {
			const match = raw.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/);
			if (match?.[1] === key) return match[2]?.trim().replace(/^["']|["']$/g, "");
		}
		return undefined;
	};
	const provider = parseProvider(get("CLANKY_MODEL_PROVIDER")) ?? "codex";
	const config: ClankyConfig = { provider };
	const codexModel = get("CLANKY_CODEX_MODEL");
	const claudeModel = get("CLANKY_CLAUDE_MODEL");
	const codexEffort = get("CLANKY_CODEX_EFFORT");
	if (codexModel !== undefined) config.codexModel = codexModel;
	if (claudeModel !== undefined) config.claudeModel = claudeModel;
	if (codexEffort !== undefined) config.codexEffort = codexEffort;
	return config;
}

async function writeEnv(updates: Record<string, string>): Promise<void> {
	const existing = await readFile(ENV_PATH, "utf8").catch(() => "");
	await writeFile(ENV_PATH, applyEnvUpserts(existing, updates), "utf8");
}

async function restartBrainMessage(prefix: string): Promise<string> {
	if (!ownsServer) {
		return `${prefix}. Saved .env.local; attached to an external eve server, so restart it to apply.`;
	}

	await stopServer();
	startServer();
	await waitForHealth();
	forwardServerOutput = terminalReady;
	return `${prefix}. Restarted Clanky.`;
}

async function fetchInfo(): Promise<{ agent?: { model?: { id?: string } } } | undefined> {
	try {
		const response = await fetch(`${HOST}/eve/v1/info`);
		if (!response.ok) return undefined;
		return (await response.json()) as { agent?: { model?: { id?: string } } };
	} catch {
		return undefined;
	}
}

async function fetchDiscordGatewayHealth(): Promise<unknown> {
	try {
		const response = await fetch(`${HOST}/discord-gateway/health`);
		return await response.json();
	} catch {
		return { running: false };
	}
}

async function probe(): Promise<"healthy" | "reachable" | "down"> {
	try {
		return (await fetch(`${HOST}/eve/v1/info`)).ok ? "healthy" : "reachable";
	} catch {
		return "down";
	}
}

function startServer(): void {
	forwardServerOutput = false;
	server = spawn(join(REPO, "node_modules", ".bin", "eve"), ["dev", "--no-ui", "--port", String(PORT)], {
		cwd: REPO,
		env: process.env,
		stdio: ["ignore", "pipe", "pipe"],
	});
	server.stdout?.on("data", (chunk: Buffer) => forwardOwnedServerOutput("stdout", chunk));
	server.stderr?.on("data", (chunk: Buffer) => forwardOwnedServerOutput("stderr", chunk));
}

function forwardOwnedServerOutput(stream: "stdout" | "stderr", chunk: Buffer): void {
	if (!forwardServerOutput) return;
	const text = chunk.toString("utf8");
	if (isSuppressedOwnedServerOutput(text)) return;
	if (stream === "stdout") process.stdout.write(text);
	else process.stderr.write(text);
}

function isSuppressedOwnedServerOutput(text: string): boolean {
	return (
		text.includes("Vercel beta terms") ||
		text.includes("Public preview: https://vercel.com/docs/release-phases/public-beta-agreement")
	);
}

async function ensureServer(): Promise<boolean> {
	const initial = await probe();
	if (initial === "healthy") return false;
	if (initial === "reachable") {
		process.stdout.write(`  \x1b[2ma server is on ${HOST} but not ready yet; waiting...\x1b[22m\n`);
		const deadline = Date.now() + 20_000;
		while (Date.now() < deadline) {
			await new Promise((resolve) => setTimeout(resolve, 800));
			if ((await probe()) === "healthy") return false;
		}
		process.stdout.write(`  \x1b[33m${HOST} is up but unhealthy. Restart the eve server that owns it; attaching anyway.\x1b[39m\n`);
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
			const response = await fetch(`${HOST}/eve/v1/info`);
			if (response.ok) return;
		} catch {
			// Server is still starting.
		}
		if (Date.now() > deadline) throw new Error(`Clanky server did not become healthy on ${HOST}`);
		await new Promise((resolve) => setTimeout(resolve, 500));
	}
}

async function stopServer(): Promise<void> {
	const child = server;
	server = null;
	forwardServerOutput = false;
	if (child === null || child.killed) return;
	child.kill("SIGTERM");
	await new Promise((resolve) => setTimeout(resolve, 300));
}

function parseProvider(value: string | undefined): ClankyConfig["provider"] | undefined {
	return value === "codex" || value === "claude" ? value : undefined;
}

function isEffortLevel(value: string): value is (typeof EFFORT_LEVELS)[number] {
	return EFFORT_LEVELS.includes(value as (typeof EFFORT_LEVELS)[number]);
}

function splitArgs(argument: string): string[] {
	return argument.trim().length === 0 ? [] : argument.trim().split(/\s+/);
}

function formatJson(value: unknown): string {
	try {
		return JSON.stringify(value);
	} catch {
		return String(value);
	}
}
