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
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http";
import { join } from "node:path";
import { promisify } from "node:util";
import { Client, type AgentInfoConnectionEntry, type AgentInfoResult, type HandleMessageStreamEvent } from "eve/client";
import {
	EveTUIRunner,
	type AgentTUIStreamResult,
	type PromptCommandHandler,
	type PromptCommandHandlerContext,
	type PromptCommandOutcome,
} from "../node_modules/eve/dist/src/cli/dev/tui/runner.js";
import {
	type AgentHeaderOptions,
	TerminalRenderer,
	type TerminalOutput,
} from "../node_modules/eve/dist/src/cli/dev/tui/terminal-renderer.js";
import {
	PROMPT_COMMANDS,
	type PromptCommand,
	type PromptCommandSpec,
} from "../node_modules/eve/dist/src/cli/dev/tui/prompt-commands.js";
import type { SetupFlowRenderer } from "../node_modules/eve/dist/src/cli/dev/tui/setup-flow.js";
import { applyEnvRemovals, applyEnvUpserts } from "../agent/lib/discord/env-file.ts";
import { browserBridgeStatus } from "../agent/lib/browser-bridge.ts";
import { buildEveDevServerEnv } from "../agent/lib/eve-dev-env.ts";
import {
	authoredMcpConnectionHasApproval,
	authoredMcpConnectionHasAuthorization,
} from "../agent/lib/curated-mcp-connections.ts";
import { inspectConnectionSearchOutput } from "../agent/lib/mcp-auth-probe.ts";
import { monitorNoReplyEvents, NO_ASSISTANT_REPLY_NOTICE } from "../agent/lib/tui-no-reply.ts";
import { isAutoApproveValue } from "../agent/lib/approvals.ts";
import {
	ALL_CODING_HARNESSES,
	BUILTIN_CODING_HARNESSES,
	CLANKY_CODING_HARNESS_ENV,
	DEFAULT_CODING_HARNESS,
	LAUNCHABLE_CODING_HARNESS_IDS,
	type CodingHarnessEnv,
	type CodingHarnessId,
	type CodingHarnessLauncher,
	type CodingRuntime,
	type LaunchableCodingHarnessId,
	codingHarnessLauncherEnvKey,
	codingHarnessModelEnvKey,
	defaultCodingRuntimeForHarness,
	parseAllowedCodingHarnesses,
	parseCodingHarnessLauncher,
	parseCodingHarnessId,
	parseCodingRuntime,
	parseHarnessCommand,
	parseLaunchableCodingHarnessId,
	resolveCodingHarness,
	serializeCommandLine,
	splitCommandLine,
} from "../agent/lib/coding-harness.ts";
import { type ClaudeCredentials, claudeCredentialStatus, loginClaude } from "../agent/lib/claude-auth.ts";
import { type CodexCredentials, codexCredentialStatus, loginCodex } from "../agent/lib/codex-auth.ts";
import {
	INTEGRATION_ROLES,
	type IntegrationRole,
	type IntegrationRoleBindings,
	listAvailableConnections,
	resolveRoleBindings,
	roleLabel,
	setRoleBinding,
} from "../agent/lib/integration-roles.ts";
import { installBrowserBridge } from "../packages/clanky-browser-bridge/src/install.ts";
import {
	listMcpServerConfigs,
	listMcpTools,
	removeMcpServer,
	setMcpServerDisabled,
	type McpServerConfig,
	type McpServerStatus,
	upsertMcpServer,
} from "../agent/lib/mcp.ts";

const REPO = process.env.CLANKY_REPO_DIR ?? process.cwd();
const PORT = resolvePort(process.env.CLANKY_EVE_PORT, 2000);
const HOST = `http://127.0.0.1:${PORT}`;
const CALLBACK_PROXY_PORT = resolvePort(process.env.CLANKY_EVE_CALLBACK_PROXY_PORT, 3000);
const ENV_PATH = join(REPO, ".env.local");
const CLANKY_HEADER_NOTE = "Clanky face on eve/client. Type /help for commands.";
const runHostCommand = promisify(execFile);

function resolvePort(value: string | undefined, fallback: number): number {
	const raw = value?.trim();
	if (raw === undefined || raw.length === 0) return fallback;
	const parsed = Number.parseInt(raw, 10);
	if (!Number.isInteger(parsed) || String(parsed) !== raw || parsed < 1 || parsed > 65_535) {
		throw new Error(`CLANKY_EVE_PORT must be an integer from 1 to 65535; got ${JSON.stringify(value)}`);
	}
	return parsed;
}

type ClankyExtensionCommandName =
	| "discord-token"
	| "login"
	| "model"
	| "harness"
	| "effort"
	| "approvals"
	| "image-model"
	| "voice"
	| "integrations"
	| "mcp"
	| "browser"
	| "status";
type ClankyExtensionCommand = {
	type: "extension";
	name: ClankyExtensionCommandName;
	argument: string;
};
type ClankyPromptCommand = PromptCommand | ClankyExtensionCommand;
type ClankyPromptCommandSpec = Omit<PromptCommandSpec, "build"> & {
	readonly build: (argument: string) => ClankyPromptCommand;
};

type SubscriptionProvider = "codex" | "claude";
const DEFAULT_LOCAL_BASE_URL = "http://127.0.0.1:11434/v1";

type ClankyConfig = {
	provider: "codex" | "claude" | "local";
	codexModel?: string;
	claudeModel?: string;
	codexEffort?: string;
	localModel?: string;
	localBaseUrl?: string;
	localEffort?: string;
	autoApprove?: string;
	codingHarness?: string;
	codingHarnesses?: string;
	codingHarnessCommand?: string;
	codingHarnessRuntime?: string;
	codingHarnessClaudeLauncher?: string;
	codingHarnessClaudeModel?: string;
	codingHarnessCodexLauncher?: string;
	codingHarnessCodexModel?: string;
	codingHarnessOpencodeLauncher?: string;
	codingHarnessOpencodeModel?: string;
	imageModel?: string;
	voiceRealtimeProvider?: string;
	voiceRealtimeModel?: string;
	voiceRealtimeVoice?: string;
	voiceTtsProvider?: string;
	elevenLabsVoiceId?: string;
	elevenLabsTtsModel?: string;
	voiceMemoryContextLimit?: string;
	voiceEveSession?: string;
};

type MenuOption = {
	value: string;
	label: string;
	hint?: string;
	description?: string;
};

const EFFORT_LEVELS = ["minimal", "low", "medium", "high", "xhigh"] as const;
const LOCAL_EFFORT_LEVELS = ["low", "medium", "high"] as const;
const VOICE_SETTINGS = [
	"realtime-provider",
	"realtime-model",
	"realtime-voice",
	"tts-provider",
	"elevenlabs-voice",
	"elevenlabs-model",
	"memory-limit",
	"eve-session",
] as const;
type VoiceSetting = (typeof VOICE_SETTINGS)[number];
type VoiceRealtimeProvider = "openai" | "xai";
type VoiceTtsProvider = "realtime" | "elevenlabs";
type VoiceSettingUpdate = {
	updates: Record<string, string>;
	message: string;
};
type McpCommandAction = "status" | "list" | "add" | "remove" | "enable" | "disable" | "auth" | "install" | "connections" | "help";
const MODEL_OPTIONS: Record<SubscriptionProvider, readonly MenuOption[]> = {
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
const LOCAL_EFFORT_OPTIONS: readonly MenuOption[] = [
	{ value: "low", label: "low" },
	{ value: "medium", label: "medium" },
	{ value: "high", label: "high", hint: "deepest" },
	{ value: "unset", label: "unset", hint: "no reasoning_effort / server default" },
	{ value: "keep-current", label: "keep current" },
];
const VOICE_SETTING_OPTIONS: readonly MenuOption[] = [
	{ value: "realtime-provider", label: "realtime provider", hint: "OpenAI or xAI" },
	{ value: "realtime-model", label: "realtime model", hint: "gpt-realtime / grok-voice-2" },
	{ value: "realtime-voice", label: "realtime voice", hint: "native provider voice" },
	{ value: "tts-provider", label: "tts provider", hint: "realtime or ElevenLabs" },
	{ value: "elevenlabs-voice", label: "ElevenLabs voice id" },
	{ value: "elevenlabs-model", label: "ElevenLabs TTS model" },
	{ value: "memory-limit", label: "voice memory context", hint: "0-50 facts" },
	{ value: "eve-session", label: "Eve voice session", hint: "voice continuity turn" },
];
const VOICE_REALTIME_PROVIDER_OPTIONS: readonly MenuOption[] = [
	{ value: "openai", label: "openai", hint: "default" },
	{ value: "xai", label: "xai", hint: "Grok realtime" },
];
const VOICE_TTS_PROVIDER_OPTIONS: readonly MenuOption[] = [
	{ value: "realtime", label: "realtime", hint: "provider-native audio" },
	{ value: "elevenlabs", label: "elevenlabs", hint: "external ElevenLabs TTS" },
];
const VOICE_EVE_SESSION_OPTIONS: readonly MenuOption[] = [
	{ value: "on", label: "on", hint: "default" },
	{ value: "off", label: "off" },
];
const CODING_HARNESS_OPTIONS: readonly MenuOption[] = [
	{ value: "clanky", label: "clanky", hint: BUILTIN_CODING_HARNESSES.clanky.description },
	{ value: "claude", label: "claude", hint: BUILTIN_CODING_HARNESSES.claude.description },
	{ value: "codex", label: "codex", hint: BUILTIN_CODING_HARNESSES.codex.description },
	{ value: "opencode", label: "opencode", hint: BUILTIN_CODING_HARNESSES.opencode.description },
	{ value: "custom", label: "custom", hint: "user-supplied command run in a Herdr pane" },
];
const CODING_HARNESS_LAUNCHER_OPTIONS: readonly MenuOption[] = [
	{ value: "default", label: "default", hint: "native CLI default model" },
	{ value: "ollama", label: "ollama", hint: "Ollama CLI integration with a local model" },
];
const CODING_RUNTIME_OPTIONS: readonly MenuOption[] = [
	{ value: "clanky", label: "clanky", hint: "allow Clanky's coding skills" },
	{ value: "native", label: "native", hint: "use the harness internals" },
	{ value: "opencode", label: "opencode", hint: "OpenCode-native alias" },
];
const MCP_ACTION_OPTIONS: readonly MenuOption[] = [
	{ value: "status", label: "status", hint: "connections + dynamic server config" },
	{ value: "list", label: "list tools", hint: "probe dynamic MCP servers" },
	{ value: "add", label: "add dynamic", hint: "stdio/http/sse no-auth or static-token MCP" },
	{ value: "auth", label: "auth connection", hint: "Linear, Figma, or another curated MCP connection" },
	{ value: "disable", label: "disable dynamic", hint: "file-backed dynamic MCP" },
	{ value: "enable", label: "enable dynamic", hint: "file-backed dynamic MCP" },
	{ value: "remove", label: "remove dynamic", hint: "delete from the file-backed store" },
	{ value: "connections", label: "connections", hint: "curated eve connection inventory" },
];
const MCP_TRANSPORT_OPTIONS: readonly MenuOption[] = [
	{ value: "stdio", label: "stdio", hint: "local command" },
	{ value: "streamable-http", label: "streamable-http", hint: "HTTP MCP endpoint" },
	{ value: "sse", label: "sse", hint: "SSE MCP endpoint" },
];
const MCP_DYNAMIC_NAME_RE = /^[a-z0-9][a-z0-9_-]*$/i;

let server: ChildProcess | null = null;
let callbackProxyServer: HttpServer | null = null;
let ownsServer = false;
let terminalReady = false;
let forwardServerOutput = false;
let effortStatusSuffix = "";

installClankyPromptCommands();

process.stdout.write("\x1b[2mstarting Clanky...\x1b[22m\n");
await reportClankyFaceToHerdr("working", "starting Clanky face");
ownsServer = await ensureServer();
await startCallbackProxy();
await reportClankyFaceToHerdr("idle", "Clanky face ready");

const client = new Client({ host: HOST });
const renderer = new TerminalRenderer({
	output: createClankyOutput(process.stdout),
	captureForeignOutput: true,
});
gateServerOutputUntilHeader(renderer);
renderNoticeForEmptyAssistantReply(renderer);
const runner = new EveTUIRunner({
	name: "Clanky",
	session: client.session(),
	client,
	renderer,
	serverUrl: HOST,
	promptCommandHandler: createClankyCommandHandler(),
});

await refreshEffortStatusSuffix();

try {
	await runner.run();
} finally {
	await reportClankyFaceToHerdr("unknown", "Clanky face stopped");
	await stopCallbackProxy();
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
			argumentHint: "[codex|claude|local] [id] [effort]",
			takesArgument: true,
			build: (argument) => ({ type: "extension", name: "model", argument }),
		},
		{
			name: "harness",
			aliases: ["coding-harness"],
			description: "Configure allowed worker harnesses and launch models",
			argumentHint: "[allow|clanky|claude|codex|opencode|custom|status] [default|ollama] [model]",
			takesArgument: true,
			build: (argument) => ({ type: "extension", name: "harness", argument }),
		},
		{
			name: "login",
			aliases: ["auth"],
			description: "Authorize a subscription provider (Claude or Codex)",
			argumentHint: "[claude|codex|status]",
			takesArgument: true,
			build: (argument) => ({ type: "extension", name: "login", argument }),
		},
		{
			name: "effort",
			aliases: [],
			description: "Set reasoning effort for the active provider",
			argumentHint: "[codex: minimal|low|medium|high|xhigh] [local: low|medium|high]",
			takesArgument: true,
			build: (argument) => ({ type: "extension", name: "effort", argument }),
		},
		{
			name: "approvals",
			aliases: ["yolo"],
			description: "Auto-approve all tool calls or restore per-tool prompting",
			argumentHint: "[auto|prompt|status]",
			takesArgument: true,
			build: (argument) => ({ type: "extension", name: "approvals", argument }),
		},
		{
			name: "image-model",
			aliases: ["images"],
			description: "Set OpenAI image generation model",
			argumentHint: "[model-id]",
			takesArgument: true,
			build: (argument) => ({ type: "extension", name: "image-model", argument }),
		},
		{
			name: "voice",
			aliases: [],
			description: "Configure Discord voice runtime",
			argumentHint: "[provider|model|realtime-voice|tts|elevenlabs|memory|eve-session] [value]",
			takesArgument: true,
			build: (argument) => ({ type: "extension", name: "voice", argument }),
		},
		{
			name: "integrations",
			aliases: [],
			description: "Bind integration roles to connections",
			argumentHint: "[role] [connection|unset]",
			takesArgument: true,
			build: (argument) => ({ type: "extension", name: "integrations", argument }),
		},
		{
			name: "mcp",
			aliases: [],
			description: "Manage dynamic MCPs and curated MCP connection auth",
			argumentHint: "[status|list|add|remove|enable|disable|auth|install]",
			takesArgument: true,
			build: (argument) => ({ type: "extension", name: "mcp", argument }),
		},
		{
			name: "browser",
			aliases: ["bridge"],
			description: "Install or inspect the browser-control extension bridge",
			argumentHint: "[status|install]",
			takesArgument: true,
			build: (argument) => ({ type: "extension", name: "browser", argument }),
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
		renderAgentHeader(withEffortInModelId(options));
		terminalReady = true;
		forwardServerOutput = server !== null;
	};
}

function renderNoticeForEmptyAssistantReply(renderer: TerminalRenderer): void {
	const renderStream = renderer.renderStream.bind(renderer);
	renderer.renderStream = async (result: AgentTUIStreamResult, options) => {
		const monitor = monitorNoReplyEvents(result.events);
		await renderStream({ ...result, events: monitor.events }, options);
		if (monitor.shouldRenderNotice()) renderer.renderNotice(NO_ASSISTANT_REPLY_NOTICE);
	};
}

// eve renders the resolved model id on the persistent status line (not the
// header). Append the active provider's reasoning effort to that id so the
// face surfaces effort the way /status reports it. claude has no effort knob,
// so the suffix stays empty there.
function withEffortInModelId(options: AgentHeaderOptions): AgentHeaderOptions {
	const info = options.info;
	if (info === undefined || effortStatusSuffix.length === 0) return options;
	return {
		...options,
		info: {
			...info,
			agent: {
				...info.agent,
				model: { ...info.agent.model, id: `${info.agent.model.id}${effortStatusSuffix}` },
			},
		},
	};
}

async function refreshEffortStatusSuffix(): Promise<void> {
	const config = await readConfig();
	const effort =
		config.provider === "codex" ? config.codexEffort : config.provider === "local" ? config.localEffort : undefined;
	effortStatusSuffix = effort !== undefined && effort.length > 0 ? ` (${effort} effort)` : "";
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
				case "login":
					return { message: await configureLogin(command.argument, context.renderer.setupFlow) };
				case "model":
					return { message: await configureModel(command.argument, context.renderer.setupFlow) };
				case "harness":
					return { message: await configureHarness(command.argument, context.renderer.setupFlow) };
				case "effort":
					return { message: await configureEffort(command.argument, context.renderer.setupFlow) };
				case "approvals":
					return { message: await configureApprovals(command.argument) };
				case "image-model":
					return { message: await configureImageModel(command.argument) };
				case "voice":
					return { message: await configureVoice(command.argument, context.renderer.setupFlow) };
				case "integrations":
					return { message: await configureIntegrations(command.argument, context.renderer.setupFlow) };
				case "mcp":
					return { message: await configureMcp(command.argument, context.renderer.setupFlow, context.renderer) };
				case "browser":
					return { message: await configureBrowserBridge(command.argument) };
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

async function configureLogin(argument: string, flow: SetupFlowRenderer | undefined): Promise<string> {
	const args = splitArgs(argument);
	const first = args[0]?.toLowerCase();
	if (first === "status") return await loginStatusText();
	let provider = parseSubscriptionProvider(first);
	if (first !== undefined && provider === undefined) {
		return `Unknown login target "${args[0]}". Use claude, codex, or status.`;
	}
	if (provider === undefined) {
		if (flow === undefined) return `${await loginStatusText()}\n\nUsage: /login [claude|codex|status]`;
		provider = await selectLoginProvider(flow);
		if (provider === undefined) return "/login cancelled.";
	}
	if (flow === undefined) {
		return `/login ${provider} needs an interactive terminal. Run pnpm ${provider}:login instead.`;
	}
	return await runLogin(provider, flow);
}

async function selectLoginProvider(flow: SetupFlowRenderer): Promise<SubscriptionProvider | undefined> {
	flow.begin("Authorize a subscription provider");
	try {
		const selected = await selectOne(
			flow,
			"Choose the subscription provider to authorize.",
			[
				{ value: "codex", label: "codex", hint: "OpenAI ChatGPT subscription" },
				{ value: "claude", label: "claude", hint: "Claude Pro/Max subscription" },
			],
			undefined,
		);
		return parseSubscriptionProvider(selected);
	} finally {
		flow.end({ preserveDiagnostics: false });
	}
}

async function runLogin(provider: SubscriptionProvider, flow: SetupFlowRenderer): Promise<string> {
	const label = provider === "claude" ? "Claude" : "Codex";
	const abort = new AbortController();
	// Print the authorize URL to scrollback (static) and wait under a single-line
	// spinner, never a tall live panel: a long-lived flow panel holding the
	// wrapping OAuth URL overflows the live region and strands its border rule on
	// every repaint. See SPEC.md face notes.
	const interrupt = flow.waitForInterrupt();
	try {
		const onUrl = (url: string): void => {
			flow.renderLine(
				[
					`Authorize Clanky on your ${label} subscription (opening your browser):`,
					url,
					"If it does not open, paste the URL above. Press Esc to cancel.",
				].join("\n"),
				"info",
			);
			flow.setStatus(`Waiting for ${label} authorization...`);
			void runHostCommand("open", [url]).catch(() => {});
		};
		const login: Promise<ClaudeCredentials | CodexCredentials> =
			provider === "claude" ? loginClaude(onUrl, abort.signal) : loginCodex(onUrl, abort.signal);
		const result = await Promise.race([
			login.then((creds) => ({ creds })),
			interrupt.promise.then(() => ({ cancelled: true as const })),
		]);
		if ("cancelled" in result) {
			abort.abort();
			return `/login ${provider} cancelled.`;
		}
		return await loginSuccessMessage(provider, result.creds.expires);
	} catch (error) {
		return `${label} login failed: ${error instanceof Error ? error.message : String(error)}`;
	} finally {
		abort.abort();
		interrupt.dispose();
		flow.setStatus(undefined);
	}
}

async function loginSuccessMessage(provider: SubscriptionProvider, expiresMs: number): Promise<string> {
	const config = await readConfig();
	const lines = [`${provider === "claude" ? "Claude" : "Codex"} login complete. Token stored (expires ${new Date(expiresMs).toISOString()}).`];
	if (config.provider !== provider) {
		lines.push(`Active provider is ${config.provider}; run /model ${provider} to switch Clanky to it.`);
	} else {
		lines.push("New turns will use the refreshed credential.");
	}
	return lines.join("\n");
}

async function loginStatusText(): Promise<string> {
	const [claude, codex] = await Promise.all([claudeCredentialStatus(), codexCredentialStatus()]);
	return ["Subscription auth:", `  claude: ${formatCredStatus(claude)}`, `  codex:  ${formatCredStatus(codex)}`].join("\n");
}

function formatProviderSummary(config: ClankyConfig): string {
	if (config.provider === "codex") return `codex${config.codexEffort ? ` (${config.codexEffort})` : ""}`;
	if (config.provider === "local") {
		const effort = config.localEffort ? ` (${config.localEffort})` : "";
		return `local (${config.localModel ?? "default"} @ ${config.localBaseUrl ?? DEFAULT_LOCAL_BASE_URL})${effort}`;
	}
	return config.provider;
}

function formatCredStatus(status: { present: boolean; expiresMs?: number }): string {
	if (!status.present) return "not logged in";
	if (status.expiresMs === undefined) return "logged in";
	const state = status.expiresMs <= Date.now() ? "expired" : "valid";
	return `${state} (expires ${new Date(status.expiresMs).toISOString()})`;
}

async function configureModel(argument: string, flow: SetupFlowRenderer | undefined): Promise<string> {
	const args = splitArgs(argument);
	const existing = await readConfig();
	let provider = parseProvider(args[0]);
	let modelId = provider === undefined ? undefined : args[1];
	let effort = provider === undefined ? undefined : args[2];
	const baseUrl = provider === "local" ? args[2] : undefined;

	if (provider === undefined && args.length > 0) {
		return `Unknown model provider "${args[0]}". Use codex, claude, or local.`;
	}

	if (provider === undefined) {
		if (flow === undefined) return "Usage: /model [codex|claude|local] [id] [effort|baseUrl]";
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
	if (provider === "local") {
		updates.CLANKY_LOCAL_BASE_URL = baseUrl ?? existing.localBaseUrl ?? DEFAULT_LOCAL_BASE_URL;
		if (modelId !== undefined && modelId.length > 0) updates.CLANKY_LOCAL_MODEL = modelId;
	} else {
		if (modelId !== undefined && modelId.length > 0) {
			updates[provider === "claude" ? "CLANKY_CLAUDE_MODEL" : "CLANKY_CODEX_MODEL"] = modelId;
		}
		if (provider === "codex" && effort !== undefined && effort.length > 0) {
			if (!isEffortLevel(effort)) return `Unknown Codex effort "${effort}".`;
			updates.CLANKY_CODEX_EFFORT = effort;
		}
	}

	await writeEnv(updates);
	return await restartBrainMessage(`Model provider set to ${provider}${modelId ? ` (${modelId})` : ""}`);
}

type HarnessUpdate = {
	updates: Record<string, string>;
	summary: string;
};

async function configureHarness(argument: string, flow: SetupFlowRenderer | undefined): Promise<string> {
	let args: string[];
	try {
		args = splitCommandLine(argument);
	} catch (error) {
		return `Invalid /harness command: ${error instanceof Error ? error.message : String(error)}`;
	}
	const config = await readConfig();
	const first = args[0]?.toLowerCase();
	if (first === "status" || first === "show") return formatCodingHarnessConfig(config);
	if (first === "allow" || first === "allowed" || first === "allowlist") {
		return await configureHarnessAllowlist(args.slice(1), config, flow);
	}

	let harness = parseCodingHarnessId(args[0]);
	if (args[0] !== undefined && harness === undefined) {
		return `Unknown coding harness "${args[0]}". Use clanky, claude, codex, opencode, custom, or status.`;
	}

	if (harness === undefined) {
		if (flow === undefined) return `${formatCodingHarnessConfig(config)}\n\n${harnessUsage()}`;
		return await configureHarnessInteractive(flow, config);
	}

	const update = buildHarnessUpdate(harness, args.slice(1), config);
	if (typeof update === "string") return update;
	await writeEnv(update.updates);
	return await restartBrainMessage(`Coding harness set to ${update.summary}`);
}

async function configureHarnessAllowlist(
	args: readonly string[],
	config: ClankyConfig,
	flow: SetupFlowRenderer | undefined,
): Promise<string> {
	let allowed: readonly CodingHarnessId[] | undefined;
	if (args.length > 0) {
		try {
			allowed = parseAllowedCodingHarnesses(args.join(","));
		} catch (error) {
			return `Invalid harness allowlist: ${error instanceof Error ? error.message : String(error)}`;
		}
	} else {
		if (flow === undefined) return `${formatCodingHarnessConfig(config)}\n\nUsage: /harness allow <all|clanky claude codex opencode custom>`;
		flow.begin("Configure allowed coding harnesses");
		try {
			flow.renderOutput(formatCodingHarnessConfig(config));
			const selected = await flow.readSelect({
				kind: "multi",
				message: "Choose which coding harnesses Clanky may use for worker panes.",
				options: CODING_HARNESS_OPTIONS,
				initialValues: configuredAllowedHarnesses(config),
				required: true,
			});
			if (selected === undefined) return "/harness allow cancelled.";
			allowed = selected.map((value) => parseCodingHarnessId(value)).filter((value): value is CodingHarnessId => value !== undefined);
		} finally {
			flow.end({ preserveDiagnostics: false });
		}
	}

	if (allowed === undefined || allowed.length === 0) return "Harness allowlist must include at least one harness.";
	const updates: Record<string, string> = { [CLANKY_CODING_HARNESS_ENV.allowed]: allowed.join(",") };
	const currentDefault = parseCodingHarnessId(config.codingHarness) ?? DEFAULT_CODING_HARNESS;
	let defaultMessage = "";
	if (!allowed.includes(currentDefault)) {
		updates[CLANKY_CODING_HARNESS_ENV.id] = allowed[0] ?? DEFAULT_CODING_HARNESS;
		defaultMessage = ` Default changed to ${updates[CLANKY_CODING_HARNESS_ENV.id]}.`;
	}
	await writeEnv(updates);
	return await restartBrainMessage(`Allowed coding harnesses set to ${allowed.join(", ")}.${defaultMessage}`);
}

async function configureHarnessInteractive(flow: SetupFlowRenderer, config: ClankyConfig): Promise<string> {
	let update: HarnessUpdate | string | undefined;
	flow.begin("Configure coding harness");
	try {
		flow.renderOutput(formatCodingHarnessConfig(config));
		const allowed = configuredAllowedHarnesses(config);
		const options = CODING_HARNESS_OPTIONS.filter((option) => allowed.includes(option.value as CodingHarnessId));
		const configured = parseCodingHarnessId(config.codingHarness) ?? DEFAULT_CODING_HARNESS;
		const current = allowed.includes(configured) ? configured : allowed[0];
		const selected = parseCodingHarnessId(
			await selectOne(flow, "Choose the default coding harness for new worker panes.", options, current),
		);
		if (selected === undefined) return "/harness cancelled.";
		let command: string[] = [];
		let launcher: CodingHarnessLauncher | undefined;
		let model: string | undefined;
		if (selected === "custom") {
			const existingCommand = config.codingHarnessCommand ?? "";
			const value = await flow.readText({
				message: "Set the custom harness command.",
				defaultValue: existingCommand,
				placeholder: "opencode run {KICKOFF}",
				validate: validateHarnessCommandText,
			});
			if (value === undefined) return "/harness cancelled.";
			command = splitCommandLine(value);
		} else if (selected !== "clanky") {
			const launchable = parseLaunchableCodingHarnessId(selected);
			if (launchable !== undefined) {
				const currentProfile = resolveCodingHarness({ harness: selected, env: codingHarnessEnv(config) });
				launcher = parseCodingHarnessLauncher(
					await selectOne(
						flow,
						`Choose how ${selected} worker panes should launch.`,
						CODING_HARNESS_LAUNCHER_OPTIONS,
						currentProfile.launcher ?? "default",
					),
				);
				if (launcher === undefined) return "/harness cancelled.";
				if (launcher === "ollama") {
					const value = await flow.readText({
						message: `Set the Ollama model for ${selected} worker panes.`,
						defaultValue: currentProfile.model ?? "",
						placeholder: "qwen3-coder:latest",
					});
					if (value === undefined) return "/harness cancelled.";
					model = value.trim();
				}
			}
		}
		update = buildHarnessUpdate(selected, [...launcherAndModelArgs(launcher, model), ...command], config);
	} finally {
		flow.end({ preserveDiagnostics: false });
	}
	if (update === undefined) return "/harness cancelled.";
	if (typeof update === "string") return update;
	await writeEnv(update.updates);
	return await restartBrainMessage(`Coding harness set to ${update.summary}`);
}

function buildHarnessUpdate(harness: CodingHarnessId, args: readonly string[], config: ClankyConfig): HarnessUpdate | string {
	const allowed = configuredAllowedHarnesses(config);
	if (!allowed.includes(harness)) {
		return `Coding harness '${harness}' is not allowed. Run /harness allow ${[...allowed, harness].join(" ")} to allow it.`;
	}
	const parsed = parseHarnessTail(args, harness !== "custom");
	if (typeof parsed === "string") return parsed;
	if (harness !== "custom" && parsed.command.length > 0) return harnessUsage();

	if (harness === "custom") {
		let command = parsed.command;
		if (command.length === 0) {
			try {
				command = parseHarnessCommand(config.codingHarnessCommand) ?? [];
			} catch (error) {
				return `Existing custom harness command is invalid: ${error instanceof Error ? error.message : String(error)}`;
			}
		}
		if (command.length === 0) return "Usage: /harness custom <command...>";
		const resolved = resolveCodingHarness({ harness, command, runtime: parsed.runtime });
		return {
			updates: {
				[CLANKY_CODING_HARNESS_ENV.id]: harness,
				[CLANKY_CODING_HARNESS_ENV.command]: serializeCommandLine(command),
				[CLANKY_CODING_HARNESS_ENV.runtime]: resolved.runtime,
			},
			summary: formatCodingHarnessSummaryFromProfile(resolved),
		};
	}

	const runtime = parsed.runtime ?? defaultCodingRuntimeForHarness(harness);
	const updates: Record<string, string> = {
		[CLANKY_CODING_HARNESS_ENV.id]: harness,
		[CLANKY_CODING_HARNESS_ENV.runtime]: runtime,
	};
	const launchable = parseLaunchableCodingHarnessId(harness);
	if (launchable !== undefined) {
		if (parsed.launcher !== undefined) updates[codingHarnessLauncherEnvKey(launchable)] = parsed.launcher;
		if (parsed.model !== undefined) updates[codingHarnessModelEnvKey(launchable)] = parsed.model;
	}
	const resolved = resolveCodingHarness({ harness, runtime, env: { ...codingHarnessEnv(config), ...updates } });
	return {
		updates,
		summary: formatCodingHarnessSummaryFromProfile(resolved),
	};
}

function parseHarnessTail(args: readonly string[], allowLauncher: boolean): {
	runtime?: CodingRuntime;
	launcher?: CodingHarnessLauncher;
	model?: string;
	command: string[];
} | string {
	let runtime: CodingRuntime | undefined;
	let launcher: CodingHarnessLauncher | undefined;
	let model: string | undefined;
	const command: string[] = [];
	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index] ?? "";
		if (arg === "--runtime") {
			const next = args[index + 1];
			const parsed = parseCodingRuntime(next);
			if (parsed === undefined) return "Usage: /harness <harness> --runtime <clanky|native|opencode>";
			runtime = parsed;
			index += 1;
			continue;
		}
		if (allowLauncher && arg === "--launcher") {
			const parsed = parseCodingHarnessLauncher(args[index + 1]);
			if (parsed === undefined) return "Usage: /harness <harness> --launcher <default|ollama>";
			launcher = parsed;
			index += 1;
			continue;
		}
		if (allowLauncher && arg.startsWith("--launcher=")) {
			const parsed = parseCodingHarnessLauncher(arg.slice("--launcher=".length));
			if (parsed === undefined) return "Usage: /harness <harness> --launcher <default|ollama>";
			launcher = parsed;
			continue;
		}
		if (allowLauncher && arg === "--model") {
			const next = args[index + 1];
			if (next === undefined || next.length === 0) return "Usage: /harness <harness> --model <ollama-model>";
			launcher = launcher ?? "ollama";
			model = next;
			index += 1;
			continue;
		}
		if (allowLauncher && arg.startsWith("--model=")) {
			const next = arg.slice("--model=".length);
			if (next.length === 0) return "Usage: /harness <harness> --model <ollama-model>";
			launcher = launcher ?? "ollama";
			model = next;
			continue;
		}
		const parsedLauncher = allowLauncher ? parseCodingHarnessLauncher(arg) : undefined;
		if (parsedLauncher !== undefined) {
			launcher = parsedLauncher;
			const next = args[index + 1];
			if (launcher === "ollama" && next !== undefined && !next.startsWith("--")) {
				model = next;
				index += 1;
			}
			continue;
		}
		if (arg.startsWith("--runtime=")) {
			const parsed = parseCodingRuntime(arg.slice("--runtime=".length));
			if (parsed === undefined) return "Usage: /harness <harness> --runtime <clanky|native|opencode>";
			runtime = parsed;
			continue;
		}
		command.push(arg);
	}
	return { runtime, launcher, model, command };
}

function launcherAndModelArgs(launcher: CodingHarnessLauncher | undefined, model: string | undefined): string[] {
	if (launcher === undefined) return [];
	const args: string[] = [launcher];
	if (model !== undefined && model.length > 0) args.push(model);
	return args;
}

function validateHarnessCommandText(value: string): string | undefined {
	try {
		return splitCommandLine(value).length === 0 ? "Enter a command." : undefined;
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
}

function formatCodingHarnessConfig(config: ClankyConfig): string {
	const allowed = formatAllowedHarnesses(config);
	try {
		const profile = resolveCodingHarness({ env: codingHarnessEnv(config) });
		return [
			"Current coding harness:",
			`allowed: ${allowed}`,
			`harness: ${profile.id} (${profile.label})`,
			`runtime: ${profile.runtime}`,
			`performer: ${profile.performer}`,
			`launcher: ${formatCodingHarnessLauncher(profile)}`,
			`command: ${profile.command === undefined ? "(built-in)" : serializeCommandLine(profile.command)}`,
			`description: ${profile.description}`,
			"",
			"Configured worker launchers:",
			...formatCodingHarnessLauncherLines(config),
		].join("\n");
	} catch (error) {
		return [`Current coding harness: invalid (${error instanceof Error ? error.message : String(error)})`, `allowed: ${allowed}`].join("\n");
	}
}

function formatCodingHarnessSummary(config: ClankyConfig): string {
	try {
		return formatCodingHarnessSummaryFromProfile(resolveCodingHarness({ env: codingHarnessEnv(config) }));
	} catch (error) {
		return `invalid (${error instanceof Error ? error.message : String(error)})`;
	}
}

function formatCodingHarnessSummaryFromProfile(profile: ReturnType<typeof resolveCodingHarness>): string {
	const command = profile.command === undefined ? "built-in" : serializeCommandLine(profile.command);
	return `${profile.id} (${profile.label}, runtime=${profile.runtime}, performer=${profile.performer}, launcher=${formatCodingHarnessLauncher(profile)}, command=${command})`;
}

function formatCodingHarnessLauncher(profile: ReturnType<typeof resolveCodingHarness>): string {
	if (profile.id === "custom") return "custom command";
	if (profile.id === "clanky") return "clanky worker (uses Clanky's /model provider)";
	if (profile.launcher === "ollama") {
		const model = profile.model === undefined ? "integration default" : profile.model;
		return `ollama launch ${profile.performer} (model=${model})`;
	}
	return "default CLI model";
}

function formatCodingHarnessLauncherLines(config: ClankyConfig): string[] {
	return LAUNCHABLE_CODING_HARNESS_IDS.map((id) => {
		const profile = resolveCodingHarness({ harness: id, env: codingHarnessEnv(config) });
		return `${id}: ${formatCodingHarnessLauncher(profile)}`;
	});
}

function configuredAllowedHarnesses(config: ClankyConfig): readonly CodingHarnessId[] {
	try {
		return parseAllowedCodingHarnesses(config.codingHarnesses) ?? ALL_CODING_HARNESSES;
	} catch {
		return ALL_CODING_HARNESSES;
	}
}

function formatAllowedHarnesses(config: ClankyConfig): string {
	try {
		const parsed = parseAllowedCodingHarnesses(config.codingHarnesses);
		return parsed === undefined ? `all (${ALL_CODING_HARNESSES.join(", ")})` : parsed.join(", ");
	} catch (error) {
		return `invalid (${error instanceof Error ? error.message : String(error)})`;
	}
}

function codingHarnessEnv(config: ClankyConfig): CodingHarnessEnv {
	return {
		[CLANKY_CODING_HARNESS_ENV.id]: config.codingHarness,
		[CLANKY_CODING_HARNESS_ENV.allowed]: config.codingHarnesses,
		[CLANKY_CODING_HARNESS_ENV.command]: config.codingHarnessCommand,
		[CLANKY_CODING_HARNESS_ENV.runtime]: config.codingHarnessRuntime,
		[codingHarnessLauncherEnvKey("claude")]: config.codingHarnessClaudeLauncher,
		[codingHarnessModelEnvKey("claude")]: config.codingHarnessClaudeModel,
		[codingHarnessLauncherEnvKey("codex")]: config.codingHarnessCodexLauncher,
		[codingHarnessModelEnvKey("codex")]: config.codingHarnessCodexModel,
		[codingHarnessLauncherEnvKey("opencode")]: config.codingHarnessOpencodeLauncher,
		[codingHarnessModelEnvKey("opencode")]: config.codingHarnessOpencodeModel,
	};
}

function harnessUsage(): string {
	return [
		"Usage:",
		"/harness",
		"/harness status",
		"/harness allow all",
		"/harness allow clanky claude codex opencode custom",
		"/harness clanky",
		"/harness claude [default|ollama] [ollama-model]",
		"/harness codex",
		"/harness codex [default|ollama] [ollama-model]",
		"/harness opencode",
		"/harness opencode [default|ollama] [ollama-model]",
		"/harness <claude|codex|opencode> --launcher <default|ollama> --model <ollama-model>",
		"/harness custom <command...>",
		"/harness custom --runtime <clanky|native|opencode> <command...>",
		"Ollama codex workers use 'ollama launch codex', not the Codex desktop app.",
		"Ollama codex runs in an isolated CODEX_HOME (CLANKY_CODEX_OLLAMA_HOME) so it",
		"does not clobber a subscription codex worker's ~/.codex.",
		"Use {KICKOFF} where the task brief should be inserted; otherwise it is appended.",
	].join("\n");
}

async function configureEffort(argument: string, flow: SetupFlowRenderer | undefined): Promise<string> {
	const existing = await readConfig();
	if (existing.provider === "claude") {
		return "Reasoning effort is not configurable for the claude provider (it uses a different thinking mechanism).";
	}
	if (existing.provider === "local") {
		let effort: string | undefined = splitArgs(argument)[0];
		const isClear = (value: string | undefined): boolean => value === "unset" || value === "none" || value === "off";
		if (effort === undefined || (!isLocalEffortLevel(effort) && !isClear(effort))) {
			if (argument.trim().length > 0) return `Unknown local effort "${argument.trim()}". Use low, medium, high, or unset.`;
			if (flow === undefined) return "Usage: /effort [low|medium|high|unset]";
			effort = await selectLocalEffort(flow, existing.localEffort);
			if (effort === undefined || effort === "keep-current") return "/effort cancelled.";
		}
		if (isClear(effort)) {
			await removeEnv(["CLANKY_LOCAL_EFFORT"]);
			return await restartBrainMessage("Local reasoning effort cleared (uses the server default)");
		}
		await writeEnv({ CLANKY_LOCAL_EFFORT: effort });
		return await restartBrainMessage(`Local reasoning effort set to ${effort}`);
	}

	let effort: string | undefined = splitArgs(argument)[0];
	if (effort === undefined || !isEffortLevel(effort)) {
		if (argument.trim().length > 0) return `Unknown Codex effort "${argument.trim()}".`;
		if (flow === undefined) return "Usage: /effort [minimal|low|medium|high|xhigh]";
		effort = await selectEffort(flow, existing.codexEffort);
		if (effort === undefined || effort === "keep-current") return "/effort cancelled.";
	}

	await writeEnv({ CLANKY_CODEX_EFFORT: effort });
	return await restartBrainMessage(`Codex reasoning effort set to ${effort}`);
}

async function configureApprovals(argument: string): Promise<string> {
	const mode = splitArgs(argument)[0]?.toLowerCase();
	if (mode === undefined || mode === "status") {
		const config = await readConfig();
		const state = isAutoApproveValue(config.autoApprove)
			? "auto (Clanky runs every tool without asking)"
			: "prompt (per-tool approval policy applies)";
		return `Approvals: ${state}. Usage: /approvals [auto|prompt]`;
	}
	if (mode !== "auto" && mode !== "prompt") {
		return `Unknown approvals mode "${mode}". Use auto, prompt, or status.`;
	}
	await writeEnv({ CLANKY_AUTO_APPROVE: mode === "auto" ? "1" : "0" });
	return await restartBrainMessage(
		mode === "auto"
			? "Auto-approve enabled; Clanky will run all tool calls without asking"
			: "Auto-approve disabled; per-tool approval policy restored",
	);
}

async function configureImageModel(argument: string): Promise<string> {
	const model = argument.trim() || "gpt-image-2";
	await writeEnv({ CLANKY_OPENAI_IMAGE_MODEL: model });
	return await restartBrainMessage(`OpenAI image model set to ${model}`);
}

async function configureVoice(argument: string, flow: SetupFlowRenderer | undefined): Promise<string> {
	const args = splitArgs(argument);
	const config = await readConfig();
	if (args.length === 0) {
		if (flow === undefined) return `${formatVoiceConfig(config)}\n\n${voiceUsage()}`;
		return await configureVoiceInteractive(flow, config, undefined);
	}

	const setting = parseVoiceSetting(args[0]);
	if (setting === "status") return formatVoiceConfig(config);
	if (setting !== undefined) {
		const value = args.slice(1).join(" ").trim();
		if (value.length > 0) return await saveVoiceSetting(setting, value);
		if (flow === undefined) return voiceSettingUsage(setting);
		return await configureVoiceInteractive(flow, config, setting);
	}

	const provider = parseVoiceRealtimeProvider(args[0]);
	if (provider !== undefined && args.length === 1) return await saveVoiceSetting("realtime-provider", provider);
	const ttsProvider = parseVoiceTtsProvider(args[0]);
	if (ttsProvider !== undefined && args.length === 1) return await saveVoiceSetting("tts-provider", ttsProvider);
	if (args.length === 1) return await saveVoiceSetting("elevenlabs-voice", args[0]);
	return voiceUsage();
}

async function configureVoiceInteractive(
	flow: SetupFlowRenderer,
	config: ClankyConfig,
	initialSetting: VoiceSetting | undefined,
): Promise<string> {
	let update: VoiceSettingUpdate | undefined;
	flow.begin("Configure Discord voice");
	try {
		flow.renderOutput(formatVoiceConfig(config));
		const selectedSetting = initialSetting ?? parseVoiceSetting(
			await selectOne(flow, "Choose the voice setting to change.", VOICE_SETTING_OPTIONS, initialSetting),
		);
		if (selectedSetting === undefined) return "/voice cancelled.";
		if (selectedSetting === "status") return formatVoiceConfig(config);
		const value = await promptVoiceSettingValue(flow, selectedSetting, config);
		if (value === undefined) return "/voice cancelled.";
		const result = buildVoiceSettingUpdate(selectedSetting, value);
		if (typeof result === "string") return result;
		update = result;
	} finally {
		flow.end({ preserveDiagnostics: false });
	}
	await writeEnv(update.updates);
	return await restartBrainMessage(update.message);
}

async function promptVoiceSettingValue(
	flow: SetupFlowRenderer,
	setting: VoiceSetting,
	config: ClankyConfig,
): Promise<string | undefined> {
	switch (setting) {
		case "realtime-provider":
			return await selectOne(
				flow,
				"Choose the realtime provider.",
				VOICE_REALTIME_PROVIDER_OPTIONS,
				parseVoiceRealtimeProvider(config.voiceRealtimeProvider) ?? "openai",
			);
		case "tts-provider":
			return await selectOne(
				flow,
				"Choose the TTS provider.",
				VOICE_TTS_PROVIDER_OPTIONS,
				inferredVoiceTtsProvider(config),
			);
		case "eve-session": {
			const enabled = parseVoiceToggle(config.voiceEveSession) ?? true;
			return await selectOne(flow, "Enable the Eve continuity session for voice turns.", VOICE_EVE_SESSION_OPTIONS, enabled ? "on" : "off");
		}
		case "memory-limit":
			return await flow.readText({
				message: "Set the voice memory context limit.",
				defaultValue: config.voiceMemoryContextLimit ?? "16",
				placeholder: "0-50",
				validate: (value) => (parseVoiceMemoryLimit(value) === undefined ? "Enter a number from 0 to 50." : undefined),
			});
		case "realtime-model":
			return await flow.readText({
				message: "Set the realtime model.",
				defaultValue: config.voiceRealtimeModel ?? "",
				placeholder: defaultRealtimeModel(config),
				validate: requiredVoiceText,
			});
		case "realtime-voice":
			return await flow.readText({
				message: "Set the realtime voice.",
				defaultValue: config.voiceRealtimeVoice ?? "marin",
				placeholder: "marin",
				validate: requiredVoiceText,
			});
		case "elevenlabs-voice":
			return await flow.readText({
				message: "Set the ElevenLabs voice id.",
				defaultValue: config.elevenLabsVoiceId ?? "",
				placeholder: "voice id",
				validate: requiredVoiceText,
			});
		case "elevenlabs-model":
			return await flow.readText({
				message: "Set the ElevenLabs TTS model.",
				defaultValue: config.elevenLabsTtsModel ?? "",
				placeholder: "eleven_flash_v2_5",
				validate: requiredVoiceText,
			});
	}
}

async function saveVoiceSetting(setting: VoiceSetting, value: string): Promise<string> {
	const update = buildVoiceSettingUpdate(setting, value);
	if (typeof update === "string") return update;
	await writeEnv(update.updates);
	return await restartBrainMessage(update.message);
}

function buildVoiceSettingUpdate(setting: VoiceSetting, rawValue: string): VoiceSettingUpdate | string {
	const value = rawValue.trim();
	if (value.length === 0) return voiceSettingUsage(setting);
	switch (setting) {
		case "realtime-provider": {
			const provider = parseVoiceRealtimeProvider(value);
			if (provider === undefined) return `Unknown voice realtime provider "${value}". Use openai or xai.`;
			return {
				updates: { CLANKY_VOICE_REALTIME_PROVIDER: provider },
				message: `Voice realtime provider set to ${provider}`,
			};
		}
		case "realtime-model":
			return {
				updates: { CLANKY_VOICE_REALTIME_MODEL: value },
				message: `Voice realtime model set to ${value}`,
			};
		case "realtime-voice":
			return {
				updates: { CLANKY_VOICE_REALTIME_VOICE: value },
				message: `Voice realtime voice set to ${value}`,
			};
		case "tts-provider": {
			const provider = parseVoiceTtsProvider(value);
			if (provider === undefined) return `Unknown voice TTS provider "${value}". Use realtime or elevenlabs.`;
			return {
				updates: { CLANKY_VOICE_TTS_PROVIDER: provider },
				message: `Voice TTS provider set to ${provider}`,
			};
		}
		case "elevenlabs-voice":
			return {
				updates: { CLANKY_ELEVENLABS_VOICE_ID: value },
				message: `ElevenLabs voice id set to ${value}`,
			};
		case "elevenlabs-model":
			return {
				updates: { CLANKY_ELEVENLABS_TTS_MODEL: value },
				message: `ElevenLabs TTS model set to ${value}`,
			};
		case "memory-limit": {
			const limit = parseVoiceMemoryLimit(value);
			if (limit === undefined) return "Voice memory context limit must be a number from 0 to 50.";
			return {
				updates: { CLANKY_VOICE_MEMORY_CONTEXT_LIMIT: String(limit) },
				message: `Voice memory context limit set to ${limit}`,
			};
		}
		case "eve-session": {
			const enabled = parseVoiceToggle(value);
			if (enabled === undefined) return `Unknown Eve voice session value "${value}". Use on or off.`;
			return {
				updates: { CLANKY_VOICE_EVE_SESSION: enabled ? "1" : "off" },
				message: `Voice Eve session ${enabled ? "enabled" : "disabled"}`,
			};
		}
	}
}

async function configureIntegrations(argument: string, flow: SetupFlowRenderer | undefined): Promise<string> {
	const available = await listAvailableConnections();
	const current = await resolveRoleBindings();
	const args = splitArgs(argument);
	const role = parseIntegrationRole(args[0]);
	if (args[0] !== undefined && role === undefined) {
		return `Unknown integration role "${args[0]}". Available roles: ${INTEGRATION_ROLES.map((entry) => entry.label).join(", ")}.`;
	}
	if (role !== undefined && args[1] !== undefined) {
		const binding = parseIntegrationBinding(args[1], available);
		if (binding === "invalid") return `Unknown connection "${args[1]}". Available connections: ${formatAvailableConnections(available)}.`;
		await setRoleBinding(role, binding);
		return integrationSavedMessage(role, binding);
	}
	if (flow === undefined) {
		return `${formatIntegrationTable(current, available)}\n\nUsage: /integrations [role] [connection|unset]`;
	}

	flow.begin("Configure integration roles");
	try {
		flow.renderOutput(formatIntegrationTable(current, available));
		const selectedRole = parseIntegrationRole(
			await selectOne(
				flow,
				"Choose the integration role to bind.",
				INTEGRATION_ROLES.map((entry) => ({
					value: entry.key,
					label: entry.label,
					hint: current[entry.key] ?? "unset",
				})),
				role,
			),
		);
		if (selectedRole === undefined) return "/integrations cancelled.";
		const selectedBinding = await selectOne(
			flow,
			`Bind ${roleLabel(selectedRole)} to a connection.`,
			[
				{ value: "unset", label: "unset", hint: "no configured connection" },
				...available.map((connection) => ({
					value: connection,
					label: connection,
					hint: current[selectedRole] === connection ? "current" : undefined,
				})),
			],
			current[selectedRole] ?? "unset",
		);
		if (selectedBinding === undefined) return "/integrations cancelled.";
		const binding = selectedBinding === "unset" ? undefined : selectedBinding;
		await setRoleBinding(selectedRole, binding);
		return integrationSavedMessage(selectedRole, binding);
	} finally {
		flow.end({ preserveDiagnostics: false });
	}
}

async function configureMcp(
	argument: string,
	flow: SetupFlowRenderer | undefined,
	renderer: PromptCommandHandlerContext["renderer"],
): Promise<string> {
	const args = splitArgs(argument);
	const action = parseMcpAction(args[0]);
	if (args[0] !== undefined && action === undefined) return `Unknown /mcp action "${args[0]}".\n\n${mcpUsage()}`;
	if (action === undefined) {
		if (flow === undefined) return `${await mcpStatusText()}\n\n${mcpUsage()}`;
		return await configureMcpInteractive(flow, renderer);
	}

	switch (action) {
		case "help":
			return mcpUsage();
		case "status":
			return await mcpStatusText();
		case "connections":
			return await mcpConnectionsText();
		case "list":
			return await mcpToolListText(args[1]);
		case "add":
			if (args.length > 1) return await addMcpServerFromArgs(args.slice(1));
			if (flow === undefined) return mcpAddUsage();
			flow.begin("Add dynamic MCP server");
			try {
				return await promptAndSaveMcpServer(flow);
			} finally {
				flow.end({ preserveDiagnostics: false });
			}
		case "remove":
			if (args[1] !== undefined) return await removeDynamicMcpServer(args[1]);
			if (flow === undefined) return "Usage: /mcp remove <name>";
			flow.begin("Remove dynamic MCP server");
			try {
				return await promptAndRemoveMcpServer(flow);
			} finally {
				flow.end({ preserveDiagnostics: false });
			}
		case "enable":
		case "disable":
			if (args[1] !== undefined) return await setDynamicMcpServerEnabled(args[1], action === "enable");
			if (flow === undefined) return `Usage: /mcp ${action} <name>`;
			flow.begin(`${action === "enable" ? "Enable" : "Disable"} dynamic MCP server`);
			try {
				return await promptAndSetMcpServerEnabled(flow, action === "enable");
			} finally {
				flow.end({ preserveDiagnostics: false });
			}
		case "auth":
			if (flow === undefined) return "Usage: /mcp auth <connection>";
			return await runMcpAuthCommand(args[1], flow, renderer);
		case "install":
			if (flow === undefined) return "Usage: /mcp install <linear|figma|connection>";
			return await runMcpInstallCommand(args[1], flow, renderer);
	}
}

async function configureMcpInteractive(
	flow: SetupFlowRenderer,
	renderer: PromptCommandHandlerContext["renderer"],
): Promise<string> {
	flow.begin("Manage MCPs");
	try {
		flow.renderOutput(await mcpStatusText());
		const action = parseMcpAction(await selectOne(flow, "Choose an MCP action.", MCP_ACTION_OPTIONS, "status"));
		if (action === undefined) return "/mcp cancelled.";
		switch (action) {
			case "status":
				return await mcpStatusText();
			case "connections":
				return await mcpConnectionsText();
			case "list": {
				const server = await selectDynamicMcpServer(flow, "Choose a dynamic MCP server to probe.", true);
				if (server === undefined) return "/mcp cancelled.";
				return await mcpToolListText(server === "all" ? undefined : server);
			}
			case "add":
				return await promptAndSaveMcpServer(flow);
			case "remove":
				return await promptAndRemoveMcpServer(flow);
			case "enable":
			case "disable":
				return await promptAndSetMcpServerEnabled(flow, action === "enable");
			case "auth": {
				const connection = await selectMcpConnectionName(flow, undefined);
				if (connection === undefined) return "/mcp cancelled.";
				return await runMcpConnectionAuthByName(connection, flow, renderer);
			}
			case "install":
			case "help":
				return mcpUsage();
		}
	} finally {
		flow.end({ preserveDiagnostics: false });
	}
}

async function runMcpInstallCommand(
	connectionName: string | undefined,
	flow: SetupFlowRenderer,
	renderer: PromptCommandHandlerContext["renderer"],
): Promise<string> {
	if (connectionName === undefined) {
		flow.begin("Install/auth MCP connection");
		try {
			const selected = await selectMcpConnectionName(flow, "linear");
			if (selected === undefined) return "/mcp install cancelled.";
			return await runMcpConnectionAuthByName(selected, flow, renderer);
		} finally {
			flow.end({ preserveDiagnostics: false });
		}
	}
	const connection = await findMcpConnection(connectionName);
	if (connection === undefined) {
		return `No curated MCP connection named "${connectionName}" is installed. Use /mcp add for dynamic no-auth/static-token MCP servers.`;
	}
	flow.begin(`Install/auth ${connection.connectionName}`);
	try {
		return await runMcpConnectionAuth(connection, flow, renderer);
	} finally {
		flow.end({ preserveDiagnostics: false });
	}
}

async function runMcpAuthCommand(
	connectionName: string | undefined,
	flow: SetupFlowRenderer,
	renderer: PromptCommandHandlerContext["renderer"],
): Promise<string> {
	flow.begin("Authorize MCP connection");
	try {
		const selected = connectionName ?? (await selectMcpConnectionName(flow, "linear"));
		if (selected === undefined) return "/mcp auth cancelled.";
		return await runMcpConnectionAuthByName(selected, flow, renderer);
	} finally {
		flow.end({ preserveDiagnostics: false });
	}
}

async function runMcpConnectionAuthByName(
	connectionName: string,
	flow: SetupFlowRenderer,
	renderer: PromptCommandHandlerContext["renderer"],
): Promise<string> {
	const connection = await findMcpConnection(connectionName);
	if (connection === undefined) return `Unknown curated MCP connection "${connectionName}".\n\n${await mcpConnectionsText()}`;
	return await runMcpConnectionAuth(connection, flow, renderer);
}

async function runMcpConnectionAuth(
	connection: AgentInfoConnectionEntry,
	flow: SetupFlowRenderer,
	renderer: PromptCommandHandlerContext["renderer"],
): Promise<string> {
	if (!mcpConnectionHasAuthorization(connection)) {
		return `${connection.connectionName} is installed and does not require authorization.`;
	}
	const abort = new AbortController();
	const interrupt = flow.waitForInterrupt();
	let pendingAuthCount = 0;
	const probe = probeMcpConnection(connection, flow, renderer, abort.signal, (count) => {
		pendingAuthCount = Math.max(0, pendingAuthCount + count);
		renderer.setConnectionAuthPendingCount?.(pendingAuthCount);
	});
	try {
		const result = await Promise.race([probe, interrupt.promise.then(() => ({ cancelled: true as const }))]);
		if ("cancelled" in result) {
			abort.abort();
			await probe.catch(() => undefined);
			return `/mcp auth ${connection.connectionName} cancelled.`;
		}
		if (result.failure !== undefined) return `${connection.connectionName} auth probe failed: ${result.failure}`;
		if (result.authOutcome === "authorized") return `${connection.connectionName} authorization complete.`;
		if (result.authOutcome !== undefined) {
			const reason = result.authReason === undefined ? "" : ` (${result.authReason})`;
			return `${connection.connectionName} authorization ${result.authOutcome}${reason}.`;
		}
		if (result.needsAuthorization) {
			const detail = result.connectionErrors.length === 0 ? "" : `\n${result.connectionErrors.join("\n")}`;
			return `${connection.connectionName} still needs authorization, but Eve did not emit an OAuth challenge. Restart Clanky's Eve server and run /mcp auth ${connection.connectionName} again.${detail}`;
		}
		if (result.connectionErrors.length > 0) return `${connection.connectionName} auth probe failed: ${result.connectionErrors.join("\n")}`;
		if (result.sawUsableTool) return `${connection.connectionName} is installed and authorization is ready.`;
		if (result.sawConnectionSearch) {
			return `${connection.connectionName} auth probe finished, but it did not discover authorized tools for that connection. Run /mcp auth ${connection.connectionName} again.`;
		}
		return `${connection.connectionName} auth probe finished, but Clanky did not call connection__search. Try asking Clanky to use ${connection.connectionName}.`;
	} catch (error) {
		return `${connection.connectionName} auth probe failed: ${error instanceof Error ? error.message : String(error)}`;
	} finally {
		abort.abort();
		interrupt.dispose();
		renderer.setConnectionAuthPendingCount?.(0);
		flow.setStatus(undefined);
	}
}

type McpAuthProbeResult = {
	sawConnectionSearch: boolean;
	sawUsableTool: boolean;
	needsAuthorization: boolean;
	connectionErrors: string[];
	authOutcome?: "authorized" | "declined" | "failed" | "timed-out";
	authReason?: string;
	failure?: string;
};

async function probeMcpConnection(
	connection: AgentInfoConnectionEntry,
	flow: SetupFlowRenderer,
	renderer: PromptCommandHandlerContext["renderer"],
	signal: AbortSignal,
	updatePendingAuth: (countDelta: number) => void,
): Promise<McpAuthProbeResult> {
	flow.renderLine(`Checking ${connection.connectionName} with connection__search. OAuth prompts will open in your browser when needed.`, "info");
	flow.setStatus(`Checking ${connection.connectionName} authorization...`);
	const session = client.session();
	const response = await session.send({ message: mcpAuthProbePrompt(connection.connectionName), signal });
	const result: McpAuthProbeResult = {
		sawConnectionSearch: false,
		sawUsableTool: false,
		needsAuthorization: false,
		connectionErrors: [],
	};
	for await (const event of response) {
		applyMcpAuthProbeEvent(event, connection, flow, renderer, updatePendingAuth, result);
	}
	return result;
}

function applyMcpAuthProbeEvent(
	event: HandleMessageStreamEvent,
	connection: AgentInfoConnectionEntry,
	flow: SetupFlowRenderer,
	renderer: PromptCommandHandlerContext["renderer"],
	updatePendingAuth: (countDelta: number) => void,
	result: McpAuthProbeResult,
): void {
	switch (event.type) {
		case "actions.requested":
			for (const action of event.data.actions) {
				if (action.kind === "tool-call" && action.toolName === "connection__search") {
					result.sawConnectionSearch = true;
					flow.setStatus(`Discovering ${connection.connectionName} connection tools...`);
				}
			}
			break;
		case "action.result": {
			const action = event.data.result;
			if (action.kind !== "tool-result" || action.toolName !== "connection__search") break;
			result.sawConnectionSearch = true;
			const inspection = inspectConnectionSearchOutput(action.output, connection.connectionName);
			if (!inspection.matchedConnection) break;
			if (inspection.needsAuthorization) {
				result.needsAuthorization = true;
				flow.renderLine(`${connection.connectionName} still needs authorization; no OAuth challenge was emitted.`, "warning");
			}
			if (inspection.sawUsableTool) result.sawUsableTool = true;
			result.connectionErrors.push(...inspection.errors);
			break;
		}
		case "authorization.required": {
			const challenge = event.data.authorization;
			const displayName = challenge?.displayName ?? titleCaseConnection(event.data.name);
			const lines = [`Authorize ${displayName} for Clanky.`];
			if (challenge?.url !== undefined) lines.push(challenge.url);
			if (challenge?.userCode !== undefined) lines.push(`code: ${challenge.userCode}`);
			if (challenge?.instructions !== undefined) lines.push(challenge.instructions);
			lines.push("Press Esc to cancel this wait.");
			flow.renderLine(lines.join("\n"), "info");
			flow.setStatus(`Waiting for ${displayName} authorization...`);
			if (challenge?.url !== undefined) void runHostCommand("open", [challenge.url]).catch(() => undefined);
			renderer.upsertConnectionAuth?.({
				name: event.data.name,
				description: event.data.description,
				state: "required",
				challenge: challengeForRenderer(challenge),
			});
			updatePendingAuth(1);
			break;
		}
		case "authorization.completed": {
			const displayName = event.data.authorization?.displayName ?? titleCaseConnection(event.data.name);
			const reason = event.data.reason === undefined ? "" : ` (${event.data.reason})`;
			const tone = event.data.outcome === "authorized" ? "success" : "warning";
			flow.renderLine(`${displayName} authorization ${event.data.outcome}${reason}.`, tone);
			result.authOutcome = event.data.outcome;
			result.authReason = event.data.reason;
			renderer.upsertConnectionAuth?.({
				name: event.data.name,
				description: connection.description,
				state: event.data.outcome,
				challenge: challengeForRenderer(event.data.authorization),
				...(event.data.reason === undefined ? {} : { reason: event.data.reason }),
			});
			updatePendingAuth(-1);
			break;
		}
		case "step.failed":
		case "turn.failed":
		case "session.failed":
			result.failure = event.data.message;
			break;
	}
}

type MappedConnectionAuthChallenge = {
	readonly url?: string;
	readonly userCode?: string;
	readonly expiresAt?: string;
	readonly instructions?: string;
};

function challengeForRenderer(challenge: MappedConnectionAuthChallenge | undefined) {
	if (challenge === undefined) return undefined;
	return {
		...(challenge.url === undefined ? {} : { url: challenge.url }),
		...(challenge.userCode === undefined ? {} : { userCode: challenge.userCode }),
		...(challenge.expiresAt === undefined ? {} : { expiresAt: challenge.expiresAt }),
		...(challenge.instructions === undefined ? {} : { instructions: challenge.instructions }),
	};
}

function mcpAuthProbePrompt(connectionName: string): string {
	return [
		"TUI MCP connection auth probe.",
		`Use connection__search to discover tools for only the curated MCP connection named "${connectionName}".`,
		"Do not call any connection tool other than connection__search. Do not create, update, delete, post, or mutate anything.",
		"If authorization is required, wait for the authorization flow to complete. Then reply with one short status sentence.",
	].join("\n");
}

async function promptAndSaveMcpServer(flow: SetupFlowRenderer): Promise<string> {
	const configured = await promptMcpServerConfig(flow);
	if (configured === undefined) return "/mcp add cancelled.";
	const result = await upsertMcpServer(configured.name, configured.config);
	return `Dynamic MCP server "${configured.name}" saved to ${result.path}. Run /mcp list ${configured.name} to verify tools.`;
}

async function promptMcpServerConfig(flow: SetupFlowRenderer): Promise<{ name: string; config: McpServerConfig } | undefined> {
	const name = await flow.readText({
		message: "Name this dynamic MCP server.",
		placeholder: "minecraft",
		validate: validateMcpServerName,
	});
	if (name === undefined) return undefined;
	const transport = parseMcpTransport(
		await selectOne(flow, "Choose the dynamic MCP transport.", MCP_TRANSPORT_OPTIONS, "stdio"),
	);
	if (transport === undefined) return undefined;

	const config: McpServerConfig = { type: transport };
	if (transport === "stdio") {
		const command = await flow.readText({
			message: "Command to start the MCP server.",
			placeholder: "node /path/to/server.js",
			validate: requiredMcpText,
		});
		if (command === undefined) return undefined;
		config.command = command.trim();
		const rawArgs = await flow.readText({
			message: "Command arguments, if any.",
			placeholder: "--stdio",
		});
		const args = parseMcpStringList(rawArgs);
		if (args.length > 0) config.args = args;
		const cwd = await flow.readText({
			message: "Working directory, if needed.",
			placeholder: process.cwd(),
		});
		if (cwd !== undefined && cwd.trim().length > 0) config.cwd = cwd.trim();
		const env = await flow.readText({
			message: "Explicit environment for the MCP subprocess, if needed.",
			placeholder: "KEY=value OTHER=value or JSON object",
			validate: validateMcpEnvText,
		});
		const parsedEnv = parseMcpEnvText(env);
		if (typeof parsedEnv === "string") {
			flow.renderLine(parsedEnv, "error");
			return undefined;
		}
		if (parsedEnv !== undefined) config.env = parsedEnv;
	} else {
		const url = await flow.readText({
			message: "MCP server URL.",
			placeholder: transport === "sse" ? "http://127.0.0.1:3000/sse" : "http://127.0.0.1:3000/mcp",
			validate: validateMcpUrl,
		});
		if (url === undefined) return undefined;
		config.url = url.trim();
	}

	const description = await flow.readText({
		message: "Description for Clanky, if useful.",
		placeholder: "Local automation MCP server",
	});
	if (description !== undefined && description.trim().length > 0) config.description = description.trim();
	const allowedTools = await flow.readText({
		message: "Allowed tools, if you want to restrict exposure.",
		placeholder: "tool_one, tool_two",
	});
	const tools = parseMcpStringList(allowedTools);
	if (tools.length > 0) config.allowedTools = tools;
	const enabled = await selectOne(
		flow,
		"Enable this dynamic MCP server now?",
		[
			{ value: "enabled", label: "enabled", hint: "default" },
			{ value: "disabled", label: "disabled" },
		],
		"enabled",
	);
	if (enabled === undefined) return undefined;
	if (enabled === "disabled") config.disabled = true;
	return { name: name.trim(), config };
}

async function addMcpServerFromArgs(args: string[]): Promise<string> {
	const parsed = parseMcpServerArgs(args);
	if (typeof parsed === "string") return `${parsed}\n\n${mcpAddUsage()}`;
	const result = await upsertMcpServer(parsed.name, parsed.config);
	return `Dynamic MCP server "${parsed.name}" saved to ${result.path}. Run /mcp list ${parsed.name} to verify tools.`;
}

function parseMcpServerArgs(args: string[]): { name: string; config: McpServerConfig } | string {
	const name = args[0];
	if (name === undefined || name.trim().length === 0) return "Missing MCP server name.";
	const nameError = validateMcpServerName(name);
	if (nameError !== undefined) return nameError;
	const transport = parseMcpTransport(args[1]);
	if (transport === undefined) return "Missing or invalid MCP transport.";
	if (transport === "stdio") {
		const command = args[2];
		if (command === undefined || command.length === 0) return "stdio MCP servers require a command.";
		const commandArgs = args.slice(3);
		return {
			name,
			config: {
				type: "stdio",
				command,
				...(commandArgs.length === 0 ? {} : { args: commandArgs }),
			},
		};
	}
	const url = args[2];
	if (url === undefined) return `${transport} MCP servers require a URL.`;
	const urlError = validateMcpUrl(url);
	if (urlError !== undefined) return urlError;
	return { name, config: { type: transport, url } };
}

async function promptAndRemoveMcpServer(flow: SetupFlowRenderer): Promise<string> {
	const name = await selectDynamicMcpServer(flow, "Choose the file-backed dynamic MCP server to remove.", false);
	if (name === undefined) return "/mcp remove cancelled.";
	const confirmed = await selectOne(
		flow,
		`Remove dynamic MCP server "${name}" from the file-backed store?`,
		[
			{ value: "cancel", label: "cancel" },
			{ value: "remove", label: "remove", hint: "delete from ~/.clanky/mcp-servers.json" },
		],
		"cancel",
	);
	if (confirmed !== "remove") return "/mcp remove cancelled.";
	return await removeDynamicMcpServer(name);
}

async function removeDynamicMcpServer(name: string): Promise<string> {
	const store = await listMcpServerConfigs();
	if (store.fileServers[name] === undefined) {
		if (store.envServers[name] !== undefined) return `Dynamic MCP server "${name}" comes from CLANKY_MCP_SERVERS; edit that environment variable to remove it.`;
		return `Unknown file-backed dynamic MCP server "${name}".`;
	}
	const result = await removeMcpServer(name);
	const stillActive = store.envServers[name] !== undefined;
	return `Dynamic MCP server "${name}" ${result.removed ? "removed" : "was not present"} from ${result.path}.${stillActive ? " It is still active from CLANKY_MCP_SERVERS." : ""}`;
}

async function promptAndSetMcpServerEnabled(flow: SetupFlowRenderer, enabled: boolean): Promise<string> {
	const name = await selectDynamicMcpServer(flow, `Choose the file-backed dynamic MCP server to ${enabled ? "enable" : "disable"}.`, false);
	if (name === undefined) return `/mcp ${enabled ? "enable" : "disable"} cancelled.`;
	return await setDynamicMcpServerEnabled(name, enabled);
}

async function setDynamicMcpServerEnabled(name: string, enabled: boolean): Promise<string> {
	const store = await listMcpServerConfigs();
	if (store.fileServers[name] === undefined) {
		if (store.envServers[name] !== undefined) return `Dynamic MCP server "${name}" comes from CLANKY_MCP_SERVERS; edit that environment variable to ${enabled ? "enable" : "disable"} it.`;
		return `Unknown file-backed dynamic MCP server "${name}".`;
	}
	const result = await setMcpServerDisabled(name, !enabled);
	const shadowed = store.envServers[name] !== undefined;
	return `Dynamic MCP server "${name}" ${enabled ? "enabled" : "disabled"} in ${result.path}.${shadowed ? " CLANKY_MCP_SERVERS still overrides this file-backed config." : ""}`;
}

async function selectDynamicMcpServer(
	flow: SetupFlowRenderer,
	message: string,
	includeAll: boolean,
): Promise<string | undefined> {
	const store = await listMcpServerConfigs();
	const names = Object.keys(includeAll ? store.servers : store.fileServers).sort((a, b) => a.localeCompare(b));
	if (names.length === 0) {
		flow.renderLine(includeAll ? "No dynamic MCP servers are configured." : "No file-backed dynamic MCP servers are configured.", "warning");
		return undefined;
	}
	return await selectOne(
		flow,
		message,
		[
			...(includeAll ? [{ value: "all", label: "all", hint: "probe every configured dynamic MCP server" }] : []),
			...names.map((name) => ({
				value: name,
				label: name,
				hint: dynamicMcpSourceHint(name, store),
			})),
		],
		includeAll ? "all" : names[0],
	);
}

async function selectMcpConnectionName(flow: SetupFlowRenderer, initialValue: string | undefined): Promise<string | undefined> {
	const connections = mcpConnections(await fetchInfo());
	if (connections.length === 0) {
		flow.renderLine("No curated MCP connections are installed in this eve server.", "warning");
		return undefined;
	}
	return await selectOne(
		flow,
		"Choose the curated MCP connection to authorize.",
		connections.map((connection) => ({
			value: connection.connectionName,
			label: connection.connectionName,
			hint: connection.hasAuthorization ? "auth" : "no auth",
			description: connection.description,
		})),
		initialValue,
	);
}

async function findMcpConnection(name: string): Promise<AgentInfoConnectionEntry | undefined> {
	const normalized = normalizeCommandToken(name);
	return mcpConnections(await fetchInfo()).find((connection) => normalizeCommandToken(connection.connectionName) === normalized);
}

function mcpConnections(info: AgentInfoResult | undefined): AgentInfoConnectionEntry[] {
	return [...(info?.connections ?? [])]
		.filter((connection) => connection.protocol === "mcp")
		.sort((a, b) => a.connectionName.localeCompare(b.connectionName));
}

async function mcpStatusText(): Promise<string> {
	const [info, store] = await Promise.all([fetchInfo(), listMcpServerConfigs()]);
	return [
		"Curated MCP connections (eve connections; OAuth/brokered auth):",
		...formatMcpConnectionLines(info),
		"",
		`Dynamic MCP servers (${store.path} + CLANKY_MCP_SERVERS):`,
		...formatDynamicMcpLines(store),
		"",
		"Use /mcp auth linear or /mcp auth figma for OAuth. Use /mcp add only for no-auth/static-token dynamic MCPs.",
	].join("\n");
}

async function mcpConnectionsText(): Promise<string> {
	return ["Curated MCP connections (installed under agent/connections):", ...formatMcpConnectionLines(await fetchInfo())].join("\n");
}

async function mcpToolListText(server: string | undefined): Promise<string> {
	const statuses = await listMcpTools({ server, timeoutMs: 10_000 });
	if (statuses.length === 0) return "No dynamic MCP servers are configured.";
	return statuses.map(formatMcpServerStatus).join("\n\n");
}

function formatMcpConnectionLines(info: AgentInfoResult | undefined): string[] {
	const connections = mcpConnections(info);
	if (connections.length === 0) return ["(none)"];
	return connections.map((connection) => {
		const auth = mcpConnectionHasAuthorization(connection) ? "auth" : "no auth";
		const approval = mcpConnectionHasApproval(connection) ? "approval" : "no approval";
		return `- ${connection.connectionName}: ${connection.protocol}, ${auth}, ${approval} - ${connection.description}`;
	});
}

function mcpConnectionHasAuthorization(connection: AgentInfoConnectionEntry): boolean {
	return connection.hasAuthorization || authoredMcpConnectionHasAuthorization(connection.connectionName);
}

function mcpConnectionHasApproval(connection: AgentInfoConnectionEntry): boolean {
	return connection.hasApproval || authoredMcpConnectionHasApproval(connection.connectionName);
}

function formatDynamicMcpLines(store: Awaited<ReturnType<typeof listMcpServerConfigs>>): string[] {
	const names = Object.keys(store.servers).sort((a, b) => a.localeCompare(b));
	if (names.length === 0) return ["(none)"];
	return names.map((name) => {
		const config = store.servers[name];
		const source = dynamicMcpSourceHint(name, store);
		const state = config?.disabled === true ? "disabled" : "enabled";
		return `- ${name}: ${formatMcpConfigTarget(config)} (${state}, ${source})`;
	});
}

function formatMcpStatusSummary(info: AgentInfoResult | undefined, store: Awaited<ReturnType<typeof listMcpServerConfigs>>): string {
	const curated = mcpConnections(info).map((connection) => connection.connectionName);
	const dynamic = Object.keys(store.servers).sort((a, b) => a.localeCompare(b));
	return `curated=${curated.length === 0 ? "none" : curated.join(",")} dynamic=${dynamic.length === 0 ? "none" : dynamic.join(",")}`;
}

function formatMcpServerStatus(status: McpServerStatus): string {
	const lines = [
		`${status.server} (${status.type}${status.disabled === true ? ", disabled" : ""})`,
		`target: ${formatMcpStatusTarget(status)}`,
	];
	if (status.description !== undefined) lines.push(`description: ${status.description}`);
	if (status.allowedTools !== undefined) lines.push(`allowed tools: ${status.allowedTools.join(", ")}`);
	if (status.error !== undefined) {
		lines.push(`error: ${status.error}`);
		return lines.join("\n");
	}
	if (status.disabled === true) {
		lines.push("tools: (disabled)");
		return lines.join("\n");
	}
	const tools = status.tools ?? [];
	if (tools.length === 0) {
		lines.push("tools: (none returned)");
		return lines.join("\n");
	}
	lines.push("tools:", ...tools.map((tool) => `- ${tool.name}${tool.description === undefined ? "" : `: ${tool.description}`}`));
	return lines.join("\n");
}

function formatMcpConfigTarget(config: McpServerConfig | undefined): string {
	if (config === undefined) return "(invalid config)";
	if (config.command !== undefined) return [config.command, ...(config.args ?? [])].join(" ");
	if (config.url !== undefined) return config.url;
	return "(missing target)";
}

function formatMcpStatusTarget(status: McpServerStatus): string {
	if (status.command !== undefined) return [status.command, ...status.args].join(" ");
	if (status.url !== undefined) return status.url;
	return "(missing target)";
}

function dynamicMcpSourceHint(name: string, store: Awaited<ReturnType<typeof listMcpServerConfigs>>): string {
	const file = store.fileServers[name] !== undefined;
	const env = store.envServers[name] !== undefined;
	if (file && env) return "file+env (env wins)";
	if (env) return "env";
	return "file";
}

function mcpUsage(): string {
	return [
		"Usage:",
		"/mcp",
		"/mcp status",
		"/mcp connections",
		"/mcp auth <linear|figma|connection>",
		"/mcp install <linear|figma|connection>",
		"/mcp list [server]",
		"/mcp add <name> stdio <command> [args...]",
		"/mcp add <name> http <url>",
		"/mcp add <name> sse <url>",
		"/mcp enable <name>",
		"/mcp disable <name>",
		"/mcp remove <name>",
		"",
		"Linear/Figma stay curated eve connections with brokered OAuth. Dynamic MCP is only for no-auth/static-token local or throwaway servers.",
	].join("\n");
}

function mcpAddUsage(): string {
	return [
		"Usage:",
		"/mcp add <name> stdio <command> [args...]",
		"/mcp add <name> http <url>",
		"/mcp add <name> sse <url>",
		"",
		"Run bare /mcp for the interactive add flow with cwd, env, description, and allowed-tool prompts.",
	].join("\n");
}

function parseMcpAction(value: string | undefined): McpCommandAction | undefined {
	if (value === undefined) return undefined;
	const normalized = normalizeCommandToken(value);
	switch (normalized) {
		case "status":
		case "show":
			return "status";
		case "list":
		case "ls":
		case "tools":
			return "list";
		case "add":
		case "create":
			return "add";
		case "remove":
		case "rm":
		case "delete":
			return "remove";
		case "enable":
		case "on":
			return "enable";
		case "disable":
		case "off":
			return "disable";
		case "auth":
		case "authorize":
		case "login":
		case "connect":
			return "auth";
		case "install":
		case "setup":
			return "install";
		case "connections":
		case "connection":
		case "curated":
			return "connections";
		case "help":
		case "usage":
			return "help";
	}
	return undefined;
}

function parseMcpTransport(value: string | undefined): McpServerConfig["type"] | undefined {
	const normalized = value === undefined ? undefined : normalizeCommandToken(value);
	if (normalized === "stdio" || normalized === "command" || normalized === "local") return "stdio";
	if (normalized === "http" || normalized === "streamablehttp" || normalized === "streamable") return "streamable-http";
	if (normalized === "sse") return "sse";
	return undefined;
}

function validateMcpServerName(value: string): string | undefined {
	const trimmed = value.trim();
	if (trimmed.length === 0) return "Enter a name.";
	return MCP_DYNAMIC_NAME_RE.test(trimmed) ? undefined : "Use letters, numbers, underscores, or dashes; start with a letter or number.";
}

function requiredMcpText(value: string): string | undefined {
	return value.trim().length === 0 ? "Enter a value." : undefined;
}

function validateMcpUrl(value: string): string | undefined {
	try {
		const url = new URL(value.trim());
		return url.protocol === "http:" || url.protocol === "https:" ? undefined : "Use an http:// or https:// URL.";
	} catch {
		return "Enter a valid URL.";
	}
}

function validateMcpEnvText(value: string): string | undefined {
	const parsed = parseMcpEnvText(value);
	return typeof parsed === "string" ? parsed : undefined;
}

function parseMcpEnvText(raw: string | undefined): Record<string, string> | string | undefined {
	const trimmed = raw?.trim() ?? "";
	if (trimmed.length === 0) return undefined;
	if (trimmed.startsWith("{")) {
		try {
			const parsed = JSON.parse(trimmed) as unknown;
			if (!isRecord(parsed) || !Object.values(parsed).every((value) => typeof value === "string")) {
				return "JSON env must be an object with string values.";
			}
			return parsed as Record<string, string>;
		} catch (error) {
			return `Invalid JSON env: ${error instanceof Error ? error.message : String(error)}`;
		}
	}
	const env: Record<string, string> = {};
	for (const part of trimmed.split(/[\s,]+/)) {
		const index = part.indexOf("=");
		if (index <= 0) return "Env entries must be KEY=value pairs or a JSON object.";
		const key = part.slice(0, index);
		if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) return `Invalid env key: ${key}`;
		env[key] = part.slice(index + 1);
	}
	return env;
}

function parseMcpStringList(raw: string | undefined): string[] {
	return (raw ?? "")
		.split(/[\s,]+/)
		.map((entry) => entry.trim())
		.filter((entry) => entry.length > 0);
}

function titleCaseConnection(name: string): string {
	return name.length === 0 ? name : `${name.charAt(0).toUpperCase()}${name.slice(1)}`;
}

async function configureBrowserBridge(argument: string): Promise<string> {
	const command = splitArgs(argument)[0] ?? "status";
	if (command === "status") return formatBrowserBridgeStatus(await browserBridgeStatus());
	if (command !== "install") return "Usage: /browser [status|install]";
	const result = await installBrowserBridge();
	const status = await browserBridgeStatus();
	return [
		"Browser bridge installed.",
		`extension: ${result.extensionDir}`,
		`extension id: ${result.extensionId}`,
		`daemon config: ${result.configFile}`,
		`port: ${result.port}`,
		"",
		"Next steps:",
		"1. Run pnpm browser-bridge:serve in this repo.",
		"2. Open chrome://extensions in Helium, Chrome, or Brave.",
		`3. Load unpacked extension: ${result.extensionDir}`,
		"",
		formatBrowserBridgeStatus(status),
	].join("\n");
}

async function statusText(): Promise<string> {
	const [info, gateway, browser, claudeAuth, codexAuth, mcpStore] = await Promise.all([
		fetchInfo(),
		fetchDiscordGatewayHealth(),
		browserBridgeStatus(),
		claudeCredentialStatus(),
		codexCredentialStatus(),
		listMcpServerConfigs(),
	]);
	const config = await readConfig();
	const bindings = await resolveRoleBindings();
	const connections = await listAvailableConnections();
	const model = info?.agent?.model?.id ?? "(model unknown)";
	const lines = [
		`model: ${model}`,
		`provider: ${formatProviderSummary(config)}`,
		`auth: claude=${formatCredStatus(claudeAuth)}; codex=${formatCredStatus(codexAuth)}`,
		`approvals: ${isAutoApproveValue(config.autoApprove) ? "auto (no prompts)" : "prompt"}`,
		`coding harness: ${formatCodingHarnessSummary(config)}`,
		`image model: ${config.imageModel ?? "gpt-image-2"}`,
		...formatVoiceStatusLines(config),
		`integrations: ${formatIntegrationSummary(bindings, connections)}`,
		`mcp: ${formatMcpStatusSummary(info, mcpStore)}`,
		`browser bridge: ${formatBrowserBridgeSummary(browser)}`,
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
				{
					value: "local",
					label: "local",
					hint: "local OpenAI-compatible server (Ollama, LM Studio, llama.cpp)",
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
		if (provider === "local") {
			const baseUrl = config.localBaseUrl ?? DEFAULT_LOCAL_BASE_URL;
			const options = await localModelOptions(baseUrl);
			return await selectOne(flow, `Choose the local model served at ${baseUrl}.`, options, config.localModel);
		}
		const current = provider === "codex" ? config.codexModel : config.claudeModel;
		return await selectOne(flow, "Choose the model Clanky should use.", MODEL_OPTIONS[provider], current);
	} finally {
		flow.end({ preserveDiagnostics: false });
	}
}

// Discover models from the local server's OpenAI-compatible /v1/models endpoint,
// so the picker works for any backend (Ollama, LM Studio, llama.cpp). Falls back
// to keep-current when the server is unreachable; models can still be set via
// `/model local <id>`.
async function localModelOptions(baseUrl: string): Promise<readonly MenuOption[]> {
	const keep: MenuOption = { value: "keep-current", label: "keep current" };
	try {
		const response = await fetch(`${baseUrl.replace(/\/+$/, "")}/models`, { signal: AbortSignal.timeout(3000) });
		if (!response.ok) return [keep];
		const body = (await response.json()) as { data?: ReadonlyArray<{ id?: unknown }> };
		const models = (body.data ?? [])
			.map((entry) => entry.id)
			.filter((id): id is string => typeof id === "string" && id.length > 0)
			.map((id) => ({ value: id, label: id }));
		return models.length > 0 ? [...models, keep] : [keep];
	} catch {
		return [keep];
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

async function selectLocalEffort(
	flow: SetupFlowRenderer,
	currentEffort: string | undefined,
): Promise<string | undefined> {
	flow.begin("Configure local reasoning effort");
	try {
		return await selectOne(flow, "Choose the local reasoning effort.", LOCAL_EFFORT_OPTIONS, currentEffort);
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

function formatVoiceConfig(config: ClankyConfig): string {
	return ["Current voice config:", ...formatVoiceStatusLines(config)].join("\n");
}

function formatVoiceStatusLines(config: ClankyConfig): string[] {
	const realtimeProvider = parseVoiceRealtimeProvider(config.voiceRealtimeProvider) ?? "openai";
	const memoryLimit = parseVoiceMemoryLimit(config.voiceMemoryContextLimit ?? "16") ?? 16;
	const eveSessionEnabled = parseVoiceToggle(config.voiceEveSession) ?? true;
	return [
		`voice realtime: ${realtimeProvider} / ${config.voiceRealtimeModel ?? defaultRealtimeModel(config)} / voice ${config.voiceRealtimeVoice ?? "marin"}`,
		`voice tts: ${inferredVoiceTtsProvider(config)}`,
		`elevenlabs voice id: ${config.elevenLabsVoiceId ?? "(unset)"}`,
		`elevenlabs tts model: ${config.elevenLabsTtsModel ?? "(default)"}`,
		`voice memory context limit: ${memoryLimit}`,
		`voice eve session: ${eveSessionEnabled ? "on" : "off"}`,
	];
}

function voiceUsage(): string {
	return [
		"Usage:",
		"/voice",
		"/voice status",
		"/voice <elevenlabs-voice-id>",
		"/voice [provider|model|realtime-voice|tts|elevenlabs|elevenlabs-model|memory|eve-session] [value]",
	].join("\n");
}

function voiceSettingUsage(setting: VoiceSetting): string {
	switch (setting) {
		case "realtime-provider":
			return "Usage: /voice provider <openai|xai>";
		case "realtime-model":
			return "Usage: /voice model <model-id>";
		case "realtime-voice":
			return "Usage: /voice realtime-voice <voice>";
		case "tts-provider":
			return "Usage: /voice tts <realtime|elevenlabs>";
		case "elevenlabs-voice":
			return "Usage: /voice elevenlabs <voice-id>";
		case "elevenlabs-model":
			return "Usage: /voice elevenlabs-model <model-id>";
		case "memory-limit":
			return "Usage: /voice memory <0-50>";
		case "eve-session":
			return "Usage: /voice eve-session <on|off>";
	}
}

function parseVoiceSetting(value: string | undefined): VoiceSetting | "status" | undefined {
	if (value === undefined) return undefined;
	const normalized = normalizeCommandToken(value);
	const direct = VOICE_SETTINGS.find((setting) => normalizeCommandToken(setting) === normalized);
	if (direct !== undefined) return direct;
	switch (normalized) {
		case "status":
		case "show":
			return "status";
		case "provider":
		case "realtime":
		case "realtimeprovider":
			return "realtime-provider";
		case "model":
		case "realtimemodel":
			return "realtime-model";
		case "voice":
		case "nativevoice":
		case "providervoice":
			return "realtime-voice";
		case "tts":
		case "ttsprovider":
			return "tts-provider";
		case "11labs":
		case "elevenlabs":
		case "elevenlabsvoice":
		case "voiceid":
			return "elevenlabs-voice";
		case "elevenlabstts":
		case "elevenlabsttsmodel":
		case "ttsmodel":
			return "elevenlabs-model";
		case "memory":
		case "memorycontext":
		case "memorycontextlimit":
			return "memory-limit";
		case "eve":
		case "evesession":
		case "continuity":
			return "eve-session";
	}
	return undefined;
}

function parseVoiceRealtimeProvider(value: string | undefined): VoiceRealtimeProvider | undefined {
	const normalized = value?.trim().toLowerCase();
	if (normalized === "openai") return "openai";
	if (normalized === "xai" || normalized === "grok") return "xai";
	return undefined;
}

function parseVoiceTtsProvider(value: string | undefined): VoiceTtsProvider | undefined {
	const normalized = value?.trim().toLowerCase();
	if (normalized === "realtime" || normalized === "native") return "realtime";
	if (normalized === "elevenlabs" || normalized === "11labs") return "elevenlabs";
	return undefined;
}

function parseVoiceToggle(value: string | undefined): boolean | undefined {
	const normalized = value?.trim().toLowerCase();
	if (normalized === undefined || normalized.length === 0) return undefined;
	if (normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on" || normalized === "enable" || normalized === "enabled") {
		return true;
	}
	if (normalized === "0" || normalized === "false" || normalized === "no" || normalized === "off" || normalized === "disable" || normalized === "disabled") {
		return false;
	}
	return undefined;
}

function parseVoiceMemoryLimit(value: string | undefined): number | undefined {
	const trimmed = value?.trim();
	if (trimmed === undefined || trimmed.length === 0 || !/^-?\d+$/.test(trimmed)) return undefined;
	const parsed = Number.parseInt(trimmed, 10);
	if (!Number.isFinite(parsed)) return undefined;
	return Math.max(0, Math.min(50, parsed));
}

function defaultRealtimeModel(config: ClankyConfig): string {
	return (parseVoiceRealtimeProvider(config.voiceRealtimeProvider) ?? "openai") === "xai" ? "grok-voice-2" : "gpt-realtime";
}

function inferredVoiceTtsProvider(config: ClankyConfig): VoiceTtsProvider {
	return parseVoiceTtsProvider(config.voiceTtsProvider) ?? (config.elevenLabsVoiceId?.trim() ? "elevenlabs" : "realtime");
}

function requiredVoiceText(value: string): string | undefined {
	return value.trim().length === 0 ? "Enter a value." : undefined;
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
	const localModel = get("CLANKY_LOCAL_MODEL");
	const localBaseUrl = get("CLANKY_LOCAL_BASE_URL");
	const localEffort = get("CLANKY_LOCAL_EFFORT");
	const autoApprove = get("CLANKY_AUTO_APPROVE");
	const codingHarness = get(CLANKY_CODING_HARNESS_ENV.id);
	const codingHarnesses = get(CLANKY_CODING_HARNESS_ENV.allowed);
	const codingHarnessCommand = get(CLANKY_CODING_HARNESS_ENV.command);
	const codingHarnessRuntime = get(CLANKY_CODING_HARNESS_ENV.runtime);
	const codingHarnessClaudeLauncher = get(codingHarnessLauncherEnvKey("claude"));
	const codingHarnessClaudeModel = get(codingHarnessModelEnvKey("claude"));
	const codingHarnessCodexLauncher = get(codingHarnessLauncherEnvKey("codex"));
	const codingHarnessCodexModel = get(codingHarnessModelEnvKey("codex"));
	const codingHarnessOpencodeLauncher = get(codingHarnessLauncherEnvKey("opencode"));
	const codingHarnessOpencodeModel = get(codingHarnessModelEnvKey("opencode"));
	const imageModel = get("CLANKY_OPENAI_IMAGE_MODEL");
	const voiceRealtimeProvider = get("CLANKY_VOICE_REALTIME_PROVIDER");
	const voiceRealtimeModel = get("CLANKY_VOICE_REALTIME_MODEL");
	const voiceRealtimeVoice = get("CLANKY_VOICE_REALTIME_VOICE");
	const voiceTtsProvider = get("CLANKY_VOICE_TTS_PROVIDER");
	const elevenLabsVoiceId = get("CLANKY_ELEVENLABS_VOICE_ID");
	const elevenLabsTtsModel = get("CLANKY_ELEVENLABS_TTS_MODEL");
	const voiceMemoryContextLimit = get("CLANKY_VOICE_MEMORY_CONTEXT_LIMIT");
	const voiceEveSession = get("CLANKY_VOICE_EVE_SESSION");
	if (codexModel !== undefined) config.codexModel = codexModel;
	if (claudeModel !== undefined) config.claudeModel = claudeModel;
	if (codexEffort !== undefined) config.codexEffort = codexEffort;
	if (localModel !== undefined) config.localModel = localModel;
	if (localBaseUrl !== undefined) config.localBaseUrl = localBaseUrl;
	if (localEffort !== undefined) config.localEffort = localEffort;
	if (autoApprove !== undefined) config.autoApprove = autoApprove;
	if (codingHarness !== undefined) config.codingHarness = codingHarness;
	if (codingHarnesses !== undefined) config.codingHarnesses = codingHarnesses;
	if (codingHarnessCommand !== undefined) config.codingHarnessCommand = codingHarnessCommand;
	if (codingHarnessRuntime !== undefined) config.codingHarnessRuntime = codingHarnessRuntime;
	if (codingHarnessClaudeLauncher !== undefined) config.codingHarnessClaudeLauncher = codingHarnessClaudeLauncher;
	if (codingHarnessClaudeModel !== undefined) config.codingHarnessClaudeModel = codingHarnessClaudeModel;
	if (codingHarnessCodexLauncher !== undefined) config.codingHarnessCodexLauncher = codingHarnessCodexLauncher;
	if (codingHarnessCodexModel !== undefined) config.codingHarnessCodexModel = codingHarnessCodexModel;
	if (codingHarnessOpencodeLauncher !== undefined) config.codingHarnessOpencodeLauncher = codingHarnessOpencodeLauncher;
	if (codingHarnessOpencodeModel !== undefined) config.codingHarnessOpencodeModel = codingHarnessOpencodeModel;
	if (imageModel !== undefined) config.imageModel = imageModel;
	if (voiceRealtimeProvider !== undefined) config.voiceRealtimeProvider = voiceRealtimeProvider;
	if (voiceRealtimeModel !== undefined) config.voiceRealtimeModel = voiceRealtimeModel;
	if (voiceRealtimeVoice !== undefined) config.voiceRealtimeVoice = voiceRealtimeVoice;
	if (voiceTtsProvider !== undefined) config.voiceTtsProvider = voiceTtsProvider;
	if (elevenLabsVoiceId !== undefined) config.elevenLabsVoiceId = elevenLabsVoiceId;
	if (elevenLabsTtsModel !== undefined) config.elevenLabsTtsModel = elevenLabsTtsModel;
	if (voiceMemoryContextLimit !== undefined) config.voiceMemoryContextLimit = voiceMemoryContextLimit;
	if (voiceEveSession !== undefined) config.voiceEveSession = voiceEveSession;
	return config;
}

async function writeEnv(updates: Record<string, string>): Promise<void> {
	const existing = await readFile(ENV_PATH, "utf8").catch(() => "");
	await writeFile(ENV_PATH, applyEnvUpserts(existing, updates), "utf8");
}

async function removeEnv(keys: string[]): Promise<void> {
	const existing = await readFile(ENV_PATH, "utf8").catch(() => "");
	await writeFile(ENV_PATH, applyEnvRemovals(existing, keys), "utf8");
}

async function restartBrainMessage(prefix: string): Promise<string> {
	await refreshEffortStatusSuffix();
	if (!ownsServer) {
		return `${prefix}. Saved .env.local; attached to an external eve server, so restart it to apply.`;
	}

	await stopServer();
	startServer();
	await waitForHealth();
	forwardServerOutput = terminalReady;
	return `${prefix}. Restarted Clanky.`;
}

async function fetchInfo(): Promise<AgentInfoResult | undefined> {
	try {
		const response = await fetch(`${HOST}/eve/v1/info`);
		if (!response.ok) return undefined;
		return (await response.json()) as AgentInfoResult;
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
		env: buildEveDevServerEnv(process.env, HOST, PORT),
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

async function startCallbackProxy(): Promise<void> {
	if (process.env.CLANKY_EVE_CALLBACK_PROXY === "0") return;
	if (CALLBACK_PROXY_PORT === PORT) return;
	if (callbackProxyServer !== null) return;

	const proxy = createServer((request, response) => {
		void proxyCallbackRequest(request, response);
	});

	try {
		await new Promise<void>((resolve, reject) => {
			proxy.once("error", reject);
			proxy.listen(CALLBACK_PROXY_PORT, "127.0.0.1", () => {
				proxy.off("error", reject);
				resolve();
			});
		});
		callbackProxyServer = proxy;
	} catch (error) {
		const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
		const message =
			code === "EADDRINUSE"
				? `Port ${CALLBACK_PROXY_PORT} is already in use; Linear/Figma OAuth callbacks may fail if Eve emits localhost:${CALLBACK_PROXY_PORT} redirect URLs.`
				: `Failed to start Eve callback proxy on ${CALLBACK_PROXY_PORT}: ${error instanceof Error ? error.message : String(error)}`;
		process.stderr.write(`  \x1b[33m${message}\x1b[39m\n`);
		await new Promise<void>((resolve) => proxy.close(() => resolve())).catch(() => undefined);
	}
}

async function proxyCallbackRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
	try {
		const path = request.url ?? "/";
		const sourceUrl = new URL(path, `http://127.0.0.1:${CALLBACK_PROXY_PORT}`);
		if (!sourceUrl.pathname.startsWith("/eve/v1/connections/")) {
			response.writeHead(404, { "content-type": "text/plain" });
			response.end("not found");
			return;
		}

		const targetUrl = new URL(`${sourceUrl.pathname}${sourceUrl.search}`, HOST);
		const method = request.method ?? "GET";
		const headers = requestHeadersForProxy(request);
		const body = method === "GET" || method === "HEAD" ? undefined : await readRequestBody(request);
		const upstream = await fetch(targetUrl, { method, headers, body });
		response.writeHead(upstream.status, Object.fromEntries(upstream.headers));
		response.end(Buffer.from(await upstream.arrayBuffer()));
	} catch (error) {
		response.writeHead(502, { "content-type": "text/plain" });
		response.end(error instanceof Error ? error.message : String(error));
	}
}

function requestHeadersForProxy(request: IncomingMessage): Headers {
	const headers = new Headers();
	for (const [name, value] of Object.entries(request.headers)) {
		if (value === undefined || name.toLowerCase() === "host") continue;
		if (Array.isArray(value)) {
			for (const entry of value) headers.append(name, entry);
		} else {
			headers.set(name, value);
		}
	}
	return headers;
}

async function readRequestBody(request: IncomingMessage): Promise<ArrayBuffer> {
	const chunks: Buffer[] = [];
	for await (const chunk of request) {
		chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
	}
	const buffer = Buffer.concat(chunks);
	return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;
}

async function stopCallbackProxy(): Promise<void> {
	const proxy = callbackProxyServer;
	callbackProxyServer = null;
	if (proxy === null) return;
	await new Promise<void>((resolve) => proxy.close(() => resolve()));
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
	return value === "codex" || value === "claude" || value === "local" ? value : undefined;
}

function parseSubscriptionProvider(value: string | undefined): SubscriptionProvider | undefined {
	return value === "codex" || value === "claude" ? value : undefined;
}

function isEffortLevel(value: string): value is (typeof EFFORT_LEVELS)[number] {
	return EFFORT_LEVELS.includes(value as (typeof EFFORT_LEVELS)[number]);
}

function isLocalEffortLevel(value: string): value is (typeof LOCAL_EFFORT_LEVELS)[number] {
	return LOCAL_EFFORT_LEVELS.includes(value as (typeof LOCAL_EFFORT_LEVELS)[number]);
}

function parseIntegrationRole(value: string | undefined): IntegrationRole | undefined {
	if (value === undefined) return undefined;
	const normalized = normalizeIntegrationToken(value);
	return INTEGRATION_ROLES.find((role) => normalizeIntegrationToken(role.key) === normalized || normalizeIntegrationToken(role.label) === normalized)
		?.key;
}

function parseIntegrationBinding(value: string, available: readonly string[]): string | undefined | "invalid" {
	if (value === "unset" || value === "none" || value === "off") return undefined;
	return available.includes(value) ? value : "invalid";
}

function normalizeIntegrationToken(value: string): string {
	return normalizeCommandToken(value);
}

function normalizeCommandToken(value: string): string {
	return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function integrationSavedMessage(role: IntegrationRole, binding: string | undefined): string {
	return `${roleLabel(role)} ${binding === undefined ? "unset" : `bound to ${binding}`}. New turns will use the updated role binding.`;
}

function formatIntegrationTable(bindings: IntegrationRoleBindings, available: readonly string[]): string {
	const roleWidth = Math.max(...INTEGRATION_ROLES.map((role) => role.label.length), "role".length);
	const bindingWidth = Math.max(
		"binding".length,
		...INTEGRATION_ROLES.map((role) => (bindings[role.key] ?? "(unset)").length),
	);
	const lines = [
		`${"role".padEnd(roleWidth)}  ${"binding".padEnd(bindingWidth)}`,
		`${"-".repeat(roleWidth)}  ${"-".repeat(bindingWidth)}`,
		...INTEGRATION_ROLES.map((role) => `${role.label.padEnd(roleWidth)}  ${(bindings[role.key] ?? "(unset)").padEnd(bindingWidth)}`),
		"",
		`available connections: ${formatAvailableConnections(available)}`,
	];
	return lines.join("\n");
}

function formatIntegrationSummary(bindings: IntegrationRoleBindings, available: readonly string[]): string {
	const bound = INTEGRATION_ROLES.map((role) => `${role.label}=${bindings[role.key] ?? "unset"}`).join(", ");
	return `${bound}; available=${formatAvailableConnections(available)}`;
}

function formatAvailableConnections(available: readonly string[]): string {
	return available.length === 0 ? "(none)" : available.join(", ");
}

function formatBrowserBridgeStatus(status: Record<string, unknown>): string {
	const paths = isRecord(status.paths) ? status.paths : {};
	const extension = isRecord(status.extension) ? status.extension : {};
	const nextSteps = Array.isArray(status.nextSteps) ? status.nextSteps.map(String) : [];
	return [
		`available: ${status.available === true ? "yes" : "no"}`,
		`daemon running: ${status.daemonRunning === true ? "yes" : "no"}`,
		`extension connected: ${status.extensionConnected === true ? "yes" : "no"}`,
		`extension dir: ${typeof extension.extensionDir === "string" ? extension.extensionDir : stringOrFallback(paths.extensionDir, "(missing)")}`,
		`config: ${formatJson(status.config)}`,
		`state: ${formatJson(status.state)}`,
		...(nextSteps.length === 0 ? [] : ["next steps:", ...nextSteps.map((step) => `- ${step}`)]),
	].join("\n");
}

function formatBrowserBridgeSummary(status: Record<string, unknown>): string {
	const nextSteps = Array.isArray(status.nextSteps) ? status.nextSteps.map(String) : [];
	const state = isRecord(status.state) ? status.state : {};
	const port = typeof state.port === "number" ? ` port=${state.port}` : "";
	const next = nextSteps.length === 0 ? "" : ` next=${nextSteps.join(" | ")}`;
	return `available=${status.available === true} daemon=${status.daemonRunning === true} extension=${status.extensionConnected === true}${port}${next}`;
}

function stringOrFallback(value: unknown, fallback: string): string {
	return typeof value === "string" && value.length > 0 ? value : fallback;
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

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
