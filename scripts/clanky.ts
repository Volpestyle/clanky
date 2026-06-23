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
import { browserBridgeStatus } from "../agent/lib/browser-bridge.ts";
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

const REPO = process.env.CLANKY_REPO_DIR ?? process.cwd();
const PORT = Number.parseInt(process.env.CLANKY_EVE_PORT ?? "2000", 10);
const HOST = `http://127.0.0.1:${PORT}`;
const ENV_PATH = join(REPO, ".env.local");
const CLANKY_HEADER_NOTE = "Clanky face on eve/client. Type /help for commands.";
const runHostCommand = promisify(execFile);

type ClankyExtensionCommandName =
	| "discord-token"
	| "login"
	| "model"
	| "effort"
	| "image-model"
	| "voice"
	| "integrations"
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
			argumentHint: "[codex|claude|local] [id] [effort]",
			takesArgument: true,
			build: (argument) => ({ type: "extension", name: "model", argument }),
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
				case "login":
					return { message: await configureLogin(command.argument, context.renderer.setupFlow) };
				case "model":
					return { message: await configureModel(command.argument, context.renderer.setupFlow) };
				case "effort":
					return { message: await configureEffort(command.argument, context.renderer.setupFlow) };
					case "image-model":
						return { message: await configureImageModel(command.argument) };
					case "voice":
						return { message: await configureVoice(command.argument, context.renderer.setupFlow) };
				case "integrations":
					return { message: await configureIntegrations(command.argument, context.renderer.setupFlow) };
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

async function configureEffort(argument: string, flow: SetupFlowRenderer | undefined): Promise<string> {
	const existing = await readConfig();
	if (existing.provider === "claude") {
		return "Reasoning effort is not configurable for the claude provider (it uses a different thinking mechanism).";
	}
	if (existing.provider === "local") {
		let effort: string | undefined = splitArgs(argument)[0];
		if (effort === undefined || !isLocalEffortLevel(effort)) {
			if (argument.trim().length > 0) return `Unknown local effort "${argument.trim()}". Use low, medium, or high.`;
			if (flow === undefined) return "Usage: /effort [low|medium|high]";
			effort = await selectLocalEffort(flow, existing.localEffort);
			if (effort === undefined || effort === "keep-current") return "/effort cancelled.";
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
	const [info, gateway, browser, claudeAuth, codexAuth] = await Promise.all([
		fetchInfo(),
		fetchDiscordGatewayHealth(),
		browserBridgeStatus(),
		claudeCredentialStatus(),
		codexCredentialStatus(),
	]);
	const config = await readConfig();
	const bindings = await resolveRoleBindings();
	const connections = await listAvailableConnections();
	const model = info?.agent?.model?.id ?? "(model unknown)";
	const lines = [
		`model: ${model}`,
		`provider: ${formatProviderSummary(config)}`,
		`auth: claude=${formatCredStatus(claudeAuth)}; codex=${formatCredStatus(codexAuth)}`,
		`image model: ${config.imageModel ?? "gpt-image-2"}`,
		...formatVoiceStatusLines(config),
		`integrations: ${formatIntegrationSummary(bindings, connections)}`,
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
