/**
 * Clanky's custom face (SPEC.md §4.2).
 *
 * The face owns Clanky-specific slash commands and server lifecycle, then
 * renders the public eve/client event stream with pi-tui.
 *
 * Run: pnpm face   (CLANKY_EVE_PORT to change the port, default 2000)
 */
import { type ChildProcess, execFile, spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http";
import { join } from "node:path";
import { promisify } from "node:util";
import {
	Editor,
	type EditorTheme,
	Key,
	Loader,
	type MarkdownTheme,
	matchesKey,
	ProcessTerminal,
	type SelectListTheme,
	Text,
	TUI,
	type Component,
	type OverlayHandle,
} from "@earendil-works/pi-tui";
import {
	Client,
	type AgentInfoConnectionEntry,
	type AgentInfoResult,
	type ClientSession,
	type HandleMessageStreamEvent,
	type InputRequest,
	type InputResponse,
	type SendTurnInput,
	type SessionState,
	type StreamOptions,
} from "eve/client";
import { applyEnvRemovals, applyEnvUpserts } from "../agent/lib/discord/env-file.ts";
import { browserBridgeStatus } from "../agent/lib/browser-bridge.ts";
import { buildEveDevServerEnv } from "../agent/lib/eve-dev-env.ts";
import {
	appendPromptHistoryEntry,
	clankyPromptHistoryPath,
	readPromptHistoryFile,
} from "../agent/lib/tui-prompt-history.ts";
import { InputRequestQueue } from "../agent/lib/tui-input-request-queue.ts";
import { ClankyBannerComponent, detectBannerCapabilities, type BannerFields } from "../agent/lib/clanky-banner.ts";
import {
	LOCAL_CONTEXT_TOKENS_ENV,
	parseLocalContextWindowTokens,
	resolveOllamaContextWindowTokens,
} from "../agent/lib/local-context.ts";
import {
	authoredMcpConnectionHasApproval,
	authoredMcpConnectionHasAuthorization,
} from "../agent/lib/curated-mcp-connections.ts";
import { inspectConnectionSearchOutput } from "../agent/lib/mcp-auth-probe.ts";
import { isAutoApproveValue } from "../agent/lib/approvals.ts";
import { isPetEnabledValue } from "../agent/lib/pet.ts";
import { buildTuiAttachmentMessage, createDroppedPathPasteRewriter, TUI_ATTACHMENT_HELP } from "../agent/lib/tui-attachments.ts";
import { createClankyFaceAnsiTheme } from "../agent/lib/clanky-face-theme.ts";
import {
	ClankyFaceRenderer,
	defaultResponseForInputRequest,
	formatContextUsage,
	formatInputRequests,
	type FaceBlockHandle,
	type FaceRenderSink,
} from "../agent/lib/clanky-face-renderer.ts";
import {
	resolveClankyCommandRows,
	resolveClankyTranscriptMouseTarget,
	resolveClankyTranscriptRows,
} from "../agent/lib/clanky-face-layout.ts";
import { isClankyLeftMouseButton, parseClankySgrMouse, type ClankySgrMouseEvent } from "../agent/lib/clanky-sgr-mouse.ts";
import { writeClankyClipboard } from "../agent/lib/clanky-clipboard.ts";
import {
	clankyCommandCompletion,
	createClankyAutocompleteProvider,
} from "../agent/lib/clanky-autocomplete.ts";
import {
	ClankyCommandTypeaheadPanel,
	ClankyCommandWorkbench,
	clankyCommandFilterFromText,
	clankyCommandTypeaheadFor,
	dismissClankyCommandTypeahead,
	isClankyCommandTypeaheadOpen,
	isExactClankyCommandTypeahead,
	moveClankyCommandTypeaheadSelection,
	selectedClankyCommandTypeahead,
	type ClankyCommandTypeaheadState,
} from "../agent/lib/clanky-command-ui.ts";
import {
	InteractiveSelectPrompt,
	InteractiveTextPrompt,
	type InteractivePromptOption,
} from "../agent/lib/clanky-interactive-flow.ts";
import { ClankyTranscriptMarkdownBlock } from "../agent/lib/clanky-transcript-block.ts";
import {
	ClankyTranscriptViewport,
	type ClankyTranscriptBlockHandle,
	type ClankyTranscriptBlockOptions,
} from "../agent/lib/clanky-transcript-viewport.ts";
import { shouldRouteClankyTranscriptGlobalInput } from "../agent/lib/clanky-transcript-key-routing.ts";
import {
	ALL_CODING_HARNESSES,
	BUILTIN_CODING_HARNESSES,
	CLANKY_CODING_HARNESS_ENV,
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
const HEALTH_TIMEOUT_MS = resolveDurationMs(process.env.CLANKY_EVE_HEALTH_TIMEOUT_MS, 180_000, "CLANKY_EVE_HEALTH_TIMEOUT_MS");
const SERVER_STOP_TIMEOUT_MS = resolveDurationMs(process.env.CLANKY_EVE_STOP_TIMEOUT_MS, 5_000, "CLANKY_EVE_STOP_TIMEOUT_MS");
const SERVER_KILL_TIMEOUT_MS = resolveDurationMs(process.env.CLANKY_EVE_KILL_TIMEOUT_MS, 2_000, "CLANKY_EVE_KILL_TIMEOUT_MS");
const BRAIN_HEALTH_POLL_MS = resolveDurationMs(process.env.CLANKY_EVE_HEALTH_POLL_MS, 5_000, "CLANKY_EVE_HEALTH_POLL_MS");
const ENV_PATH = join(REPO, ".env.local");
const DEV_SERVER_FILE = join(REPO, ".eve", "dev-server.json");
const OWNED_SERVER_STARTUP_OUTPUT_LIMIT = 8_000;
const DEFAULT_TURN_TRACE_MODE: TurnTraceMode = "no-reply";
const CLANKY_FACE_HERDR_PANE_ID_ENV = "CLANKY_FACE_HERDR_PANE_ID";
const CLANKY_FACE_HERDR_TAB_ID_ENV = "CLANKY_FACE_HERDR_TAB_ID";
const CLANKY_FACE_HERDR_WORKSPACE_ID_ENV = "CLANKY_FACE_HERDR_WORKSPACE_ID";
// Mode 1002 reports drag motion while a button is held (1000 only reports
// press/release), which the transcript needs to track a selection gesture.
const CLANKY_MOUSE_TRACKING_ENABLE = "\x1b[?1002h\x1b[?1006h";
const CLANKY_MOUSE_TRACKING_DISABLE = "\x1b[?1002l\x1b[?1006l";
const MIN_TRANSCRIPT_ROWS = 4;
const runHostCommand = promisify(execFile);
const faceCapabilities = detectBannerCapabilities(process.stdout);
const ansi = createClankyFaceAnsiTheme(faceCapabilities);

const selectListTheme: SelectListTheme = {
	description: ansi.dim,
	noMatch: ansi.dim,
	scrollInfo: ansi.dim,
	selectedPrefix: ansi.cyan,
	selectedText: ansi.bold,
};

const editorTheme: EditorTheme = {
	borderColor: ansi.dim,
	selectList: selectListTheme,
};

const markdownTheme: MarkdownTheme = {
	bold: ansi.bold,
	code: ansi.yellow,
	codeBlock: ansi.green,
	codeBlockBorder: ansi.dim,
	heading: ansi.cyan,
	hr: ansi.dim,
	italic: ansi.italic,
	link: ansi.blue,
	linkUrl: ansi.dim,
	listBullet: ansi.cyan,
	quote: ansi.italic,
	quoteBorder: ansi.dim,
	strikethrough: ansi.dim,
	underline: ansi.underline,
};

const commandUiTheme = {
	bold: ansi.bold,
	cyan: ansi.cyan,
	dim: ansi.dim,
	green: ansi.green,
	red: ansi.red,
	yellow: ansi.yellow,
};

function resolvePort(value: string | undefined, fallback: number): number {
	const raw = value?.trim();
	if (raw === undefined || raw.length === 0) return fallback;
	const parsed = Number.parseInt(raw, 10);
	if (!Number.isInteger(parsed) || String(parsed) !== raw || parsed < 1 || parsed > 65_535) {
		throw new Error(`CLANKY_EVE_PORT must be an integer from 1 to 65535; got ${JSON.stringify(value)}`);
	}
	return parsed;
}

function resolveDurationMs(value: string | undefined, fallback: number, envName: string): number {
	const raw = value?.trim();
	if (raw === undefined || raw.length === 0) return fallback;
	const parsed = Number.parseInt(raw, 10);
	if (!Number.isInteger(parsed) || String(parsed) !== raw || parsed < 1) {
		throw new Error(`${envName} must be a positive integer number of milliseconds; got ${JSON.stringify(value)}`);
	}
	return parsed;
}

function parseTurnTraceMode(value: string | undefined): TurnTraceMode | undefined {
	const normalized = value?.trim().toLowerCase();
	if (normalized === undefined || normalized.length === 0) return undefined;
	if (normalized === "off" || normalized === "none" || normalized === "0" || normalized === "false") return "off";
	if (normalized === "no-reply" || normalized === "noreply" || normalized === "empty") return "no-reply";
	if (normalized === "all" || normalized === "on" || normalized === "1" || normalized === "true") return "all";
	return undefined;
}

function parseBooleanFlag(value: string | undefined): boolean | undefined {
	const normalized = value?.trim().toLowerCase();
	if (normalized === undefined || normalized.length === 0) return undefined;
	if (normalized === "on" || normalized === "1" || normalized === "true" || normalized === "show") return true;
	if (normalized === "off" || normalized === "0" || normalized === "false" || normalized === "hide") return false;
	return undefined;
}

type ClankyExtensionCommandName =
	| "discord-token"
	| "discord-scope"
	| "login"
	| "model"
	| "harness"
	| "effort"
	| "approvals"
	| "image-model"
	| "vision-model"
	| "attachments"
	| "voice"
	| "integrations"
	| "mcp"
	| "browser"
	| "trace"
	| "pet"
	| "header"
	| "status";
type ClankyExtensionCommand = {
	type: "extension";
	name: ClankyExtensionCommandName;
	argument: string;
};
type NativePromptCommand =
	| { type: "help" }
	| { type: "new" }
	| { type: "clear" }
	| { type: "exit" };
type ClankyPromptCommand = NativePromptCommand | ClankyExtensionCommand;
type ClankyPromptCommandSpec = {
	readonly name: string;
	readonly aliases: readonly string[];
	readonly description: string;
	readonly argumentHint?: string;
	readonly takesArgument: boolean;
	readonly build: (argument: string) => ClankyPromptCommand;
};

type PromptCommandOutcome = {
	readonly clearTranscript?: boolean;
	readonly exit?: boolean;
	readonly message?: string;
	readonly newSession?: boolean;
};
type CommandLogTone = "error" | "success";

type CommandRenderer = {
	readonly setupFlow: SetupFlow | undefined;
	setConnectionAuthPendingCount?(count: number): void;
	upsertConnectionAuth?(state: ConnectionAuthState): void;
};

type ConnectionAuthState = {
	readonly name: string;
	readonly description?: string;
	readonly state: "required" | "authorized" | "declined" | "failed" | "timed-out";
	readonly challenge?: MappedConnectionAuthChallenge;
	readonly reason?: string;
};

type FlowLineTone = "error" | "info" | "success" | "warning";

type SetupFlow = {
	begin(title: string): void;
	end(options?: { readonly preserveDiagnostics?: boolean }): void;
	renderOutput(text: string): void;
	renderLine(text: string, tone?: FlowLineTone): void;
	setStatus(status: string | undefined): void;
	readText(options: {
		readonly message: string;
		readonly defaultValue?: string;
		readonly placeholder?: string;
		readonly validate?: (value: string) => string | undefined;
	}): Promise<string | undefined>;
	readSelect(options: {
		readonly kind: "multi" | "single";
		readonly message: string;
		readonly options: readonly MenuOption[];
		readonly initialValue?: string;
		readonly initialValues?: readonly string[];
		readonly required?: boolean;
	}): Promise<string[] | undefined>;
	waitForInterrupt(): {
		readonly promise: Promise<void>;
		dispose(): void;
	};
};
type SetupFlowController = SetupFlow & {
	handleSubmit(text: string): boolean;
	isWaitingForInput(): boolean;
};

type SubscriptionProvider = "codex" | "claude";
const DEFAULT_LOCAL_BASE_URL = "http://127.0.0.1:11434/v1";
const DISCORD_SCOPE_ENV = {
	guilds: "CLANKY_DISCORD_ALLOWED_GUILD_IDS",
	channels: "CLANKY_DISCORD_ALLOWED_CHANNEL_IDS",
	dms: "CLANKY_DISCORD_ALLOW_DMS",
} as const;

type ClankyConfig = {
	provider: "codex" | "claude" | "local";
	codexModel?: string;
	claudeModel?: string;
	codexEffort?: string;
	localModel?: string;
	localBaseUrl?: string;
	localEffort?: string;
	localContextTokens?: string;
	localVisionModel?: string;
	openAiVisionModel?: string;
	autoApprove?: string;
	pet?: string;
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
	discordAllowedGuildIds?: string;
	discordAllowedChannelIds?: string;
	discordAllowDms?: string;
};

type BrainHealthState =
	| { state: "unknown"; checkedAt?: number }
	| { state: "restarting"; checkedAt: number; detail?: string }
	| { state: "healthy"; checkedAt: number }
	| { state: "unhealthy"; checkedAt: number; status: number; statusText: string; detail?: string }
	| { state: "down"; checkedAt: number; detail: string };

type TurnTraceMode = "off" | "no-reply" | "all";

type MenuOption = {
	value: string;
	label: string;
	hint?: string;
	description?: string;
};

interface DevServerRecord {
	readonly pid: number;
	readonly updatedAt?: string;
	readonly url: string;
}

interface DiscoveredHost {
	readonly host: string;
	readonly source: string;
}

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
type ImageModelUpdate = {
	updates?: Record<string, string>;
	removals?: string[];
	message: string;
};
type DiscordTokenUpdate = {
	updates: Record<string, string>;
	message: string;
};
type DiscordScopeUpdate = {
	updates: Record<string, string>;
	removals: string[];
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
const DISCORD_CREDENTIAL_KIND_OPTIONS: readonly MenuOption[] = [
	{ value: "bot-token", label: "bot token", hint: "recommended" },
	{ value: "user-token", label: "user token", hint: "only when explicitly needed" },
];
const DISCORD_TOKEN_VOICE_OPTIONS: readonly MenuOption[] = [
	{ value: "off", label: "chat only" },
	{ value: "on", label: "chat + voice", hint: "enable Discord voice runtime" },
];
const APPROVAL_OPTIONS: readonly MenuOption[] = [
	{ value: "status", label: "view current mode" },
	{ value: "auto", label: "auto approve", hint: "run tool calls without prompts" },
	{ value: "prompt", label: "prompt", hint: "restore per-tool approvals" },
];
const TRACE_OPTIONS: readonly MenuOption[] = [
	{ value: "status", label: "view current mode" },
	{ value: "off", label: "off" },
	{ value: "no-reply", label: "no-reply", hint: "show compact no-reply traces" },
	{ value: "all", label: "all", hint: "show compact trace after every turn" },
];
const PET_OPTIONS: readonly MenuOption[] = [
	{ value: "status", label: "view current state" },
	{ value: "on", label: "on" },
	{ value: "off", label: "off" },
];
const BROWSER_BRIDGE_OPTIONS: readonly MenuOption[] = [
	{ value: "status", label: "view bridge status" },
	{ value: "install", label: "install bridge", hint: "write extension and daemon config" },
];
const DEFAULT_OPENAI_IMAGE_MODEL = "gpt-image-2";
const CUSTOM_IMAGE_MODEL_OPTION = "__custom_image_model__";
const CLEAR_IMAGE_MODEL_OPTION = "__clear_image_model__";
const DISCORD_SCOPE_ACTION_OPTIONS: readonly MenuOption[] = [
	{ value: "status", label: "view scope", hint: "show current allowlists" },
	{ value: "set-guilds", label: "set servers", hint: "replace server allowlist" },
	{ value: "set-channels", label: "set channels", hint: "replace channel/thread allowlist" },
	{ value: "add-guilds", label: "add servers", hint: "append server ids" },
	{ value: "add-channels", label: "add channels", hint: "append channel/thread ids" },
	{ value: "remove-guilds", label: "remove servers", hint: "choose existing server ids" },
	{ value: "remove-channels", label: "remove channels", hint: "choose existing channel/thread ids" },
	{ value: "dms", label: "DMs", hint: "allow or block private replies" },
	{ value: "clear", label: "clear scope", hint: "remove allowlist settings" },
];
const DISCORD_SCOPE_CLEAR_OPTIONS: readonly MenuOption[] = [
	{ value: "all", label: "all", hint: "servers, channels, and DM override" },
	{ value: "guilds", label: "servers", hint: "server allowlist only" },
	{ value: "channels", label: "channels", hint: "channel/thread allowlist only" },
	{ value: "dms", label: "DM override", hint: "return DMs to default allowed" },
];
const DISCORD_SCOPE_TARGET_OPTIONS: readonly MenuOption[] = [
	{ value: "guilds", label: "servers", hint: "Discord guild/server ids" },
	{ value: "channels", label: "channels", hint: "channel, thread, or parent-channel ids" },
];
const DISCORD_DM_OPTIONS: readonly MenuOption[] = [
	{ value: "on", label: "allow DMs" },
	{ value: "off", label: "block DMs" },
];
const CODING_HARNESS_OPTIONS: readonly MenuOption[] = [
	{ value: "clanky", label: "clanky", hint: BUILTIN_CODING_HARNESSES.clanky.description },
	{ value: "claude", label: "claude", hint: BUILTIN_CODING_HARNESSES.claude.description },
	{ value: "codex", label: "codex", hint: BUILTIN_CODING_HARNESSES.codex.description },
	{ value: "opencode", label: "opencode", hint: BUILTIN_CODING_HARNESSES.opencode.description },
	{ value: "custom", label: "custom", hint: "user-supplied command run in a Herdr pane" },
];
const CODING_RUNTIME_OPTIONS: readonly MenuOption[] = [
	{ value: "clanky", label: "clanky", hint: "allow Clanky's coding skills" },
	{ value: "native", label: "native", hint: "use the harness internals" },
	{ value: "opencode", label: "opencode", hint: "OpenCode-native alias" },
];
const CODING_HARNESS_ACTION_OPTIONS: readonly MenuOption[] = [
	{ value: "status", label: "view current config" },
	{ value: "allow", label: "allowed harnesses", hint: "toggle workers Clanky may use" },
	{ value: "fallback", label: "fallback harness", hint: "choose default worker, launcher, and model" },
	{ value: "custom", label: "custom command", hint: "set command + runtime for custom worker" },
];
const CODING_HARNESS_LAUNCHER_OPTIONS: readonly MenuOption[] = [
	{ value: "default", label: "default", hint: "use the CLI's configured model" },
	{ value: "ollama", label: "ollama", hint: "launch through ollama with a model id" },
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
const MCP_CONNECTION_INFO_UNAVAILABLE = "(curated connection inventory unavailable: /eve/v1/info is not healthy)";

let server: ChildProcess | null = null;
let callbackProxyServer: HttpServer | null = null;
let ownsServer = false;
let forwardServerOutput = false;
let ownedServerStartupOutput = "";
let ownedServerStartError: Error | undefined;
let brainHost = HOST;
let effortStatusSuffix = "";
let currentContextSize: number | undefined;
let latestInfo: AgentInfoResult | undefined;
let brainHealth: BrainHealthState = { state: "unknown" };
let brainHealthMonitor: ReturnType<typeof setInterval> | undefined;
let brainHealthRefreshRunning = false;
let brainRestartInProgress = false;
let brainHealthGeneration = 0;
let uiReady = false;
let turnTraceMode = parseTurnTraceMode(process.env.CLANKY_TURN_TRACE) ?? DEFAULT_TURN_TRACE_MODE;
let headerVisible = parseBooleanFlag(process.env.CLANKY_HEADER) ?? true;
let runningTurn: Promise<void> | undefined;
let isResponding = false;
let shutdownStarted = false;
let activeLoader: Loader | undefined;
let commandPaletteOverlay: OverlayHandle | undefined;
let commandTypeaheadState: ClankyCommandTypeaheadState | undefined;
let currentStatusLabel = "starting";
let connectionAuthPendingCount = 0;
let mouseTrackingEnabled = false;
let transcriptSelectionActive = false;

const COMMANDS = buildClankyPromptCommands();

process.stdout.write("\x1b[2mstarting Clanky...\x1b[22m\n");
await reportClankyFaceToHerdr("working", "starting Clanky face");
await refreshEffortStatusSuffix();
ownsServer = await ensureServer();
await startCallbackProxy();
await reportClankyFaceToHerdr("idle", "Clanky face ready");

const baseClient = new Client({ host: brainHost, preserveCompletedSessions: true });
const client = createAttachmentAwareClient(baseClient);
const initialInfo = await fetchInfo();
if (initialInfo !== undefined) updateLatestInfo(initialInfo);
let session: ClientSession = client.session();

const tui = new TUI(new ProcessTerminal());
tui.setClearOnShrink(true);
const banner = new ClankyBannerComponent(buildBannerFields(latestInfo), faceCapabilities, headerVisible);
const status = new Text("", 1, 0);
const editor = new Editor(tui, editorTheme, { autocompleteMaxVisible: 12 });
const commandTypeaheadPanel = new ClankyCommandTypeaheadPanel(COMMANDS, commandUiTheme, {
	maxVisibleRows: maxCommandTypeaheadRows,
});
const transcriptViewport = new ClankyTranscriptViewport(maxTranscriptRows, {
	dim: ansi.dim,
	selected: ansi.cyan,
}, { blockSpacing: 1 });
const faceRenderer = new ClankyFaceRenderer(createFaceRenderSink());
const setupFlow = createSetupFlow(createFlowHost());
const commandRenderer: CommandRenderer = {
	setupFlow,
	setConnectionAuthPendingCount(count: number): void {
		connectionAuthPendingCount = Math.max(0, count);
		refreshStatusView();
	},
	upsertConnectionAuth(state: ConnectionAuthState): void {
		const reason = state.reason === undefined ? "" : ` (${state.reason})`;
		insertMarkdown(`**Connection authorization ${state.state}**\n\n${state.name}${reason}`);
	},
};
const rewriteDroppedPaste = createDroppedPathPasteRewriter({ cwd: REPO });

editor.setAutocompleteProvider(createClankyAutocompleteProvider(COMMANDS, REPO, {
	async listMcpConnectionNames(): Promise<readonly string[]> {
		return mcpConnections(latestInfo ?? await fetchInfo()).map((connection) => connection.connectionName);
	},
	async listMcpServerNames(): Promise<readonly string[]> {
		const store = await listMcpServerConfigs();
		return Object.keys(store.servers).sort((left, right) => left.localeCompare(right));
	},
	async listIntegrationConnectionNames(): Promise<readonly string[]> {
		return await listAvailableConnections();
	},
}));
await seedPromptHistory(editor);
editor.onChange = (text) => {
	refreshCommandSurface(text);
};
editor.onSubmit = (submitted) => {
	refreshCommandSurface("");
	if (setupFlow.handleSubmit(submitted)) return;
	// Capture before submitting: anything entered while a turn is already
	// streaming is a concurrent slash command (or a deferred prompt) and must not
	// clobber the tracked in-flight turn.
	const concurrent = isResponding;
	const submission = submitEditorText(submitted).catch((error) => {
		insertMarkdown(`**Error**\n\n${formatError(error)}`);
	});
	if (concurrent) return;
	const tracked: Promise<void> = submission.finally(() => {
		if (runningTurn === tracked) runningTurn = undefined;
	});
	runningTurn = tracked;
};

tui.addChild(banner);
tui.addChild(transcriptViewport);
tui.addChild(status);
tui.addChild(commandTypeaheadPanel);
tui.addChild(editor);
tui.setFocus(editor);
tui.addInputListener((data) => {
	if ((matchesKey(data, Key.ctrl("t")) || data === "\x14") && !setupFlow.isWaitingForInput() && commandPaletteOverlay?.isFocused() !== true) {
		toggleTranscriptFocus();
		return { consume: true };
	}
	// Drag selection and selection copy/clear work regardless of which pane holds
	// key focus, so they run before the focus-specific branches below.
	const mouse = parseClankySgrMouse(data);
	if (mouse !== undefined && mouse.kind !== "wheel") {
		handleTranscriptSelectionMouse(mouse);
		return { consume: true };
	}
	if (matchesKey(data, Key.ctrl("c")) && transcriptViewport.hasSelection()) {
		void copyTranscriptSelection();
		transcriptViewport.clearSelection();
		tui.requestRender();
		return { consume: true };
	}
	if (matchesKey(data, Key.escape) && transcriptViewport.hasSelection()) {
		transcriptViewport.clearSelection();
		tui.requestRender();
		return { consume: true };
	}
	if (transcriptViewport.focused) {
		if (matchesKey(data, Key.escape)) {
			tui.setFocus(editor);
			refreshStatusView();
			return { consume: true };
		}
		if (isTranscriptNavigationInput(data)) {
			transcriptViewport.handleInput(data);
			tui.requestRender();
			return { consume: true };
		}
		return { consume: true };
	}
	if (matchesKey(data, Key.ctrl("/")) || data === "\x1f") {
		if (setupFlow.isWaitingForInput()) return undefined;
		openCommandPalette();
		return { consume: true };
	}
	if (matchesKey(data, Key.ctrl("c"))) {
		if (commandPaletteOverlay?.isFocused() === true) {
			closeCommandPalette();
			return { consume: true };
		}
		if (setupFlow.isWaitingForInput()) {
			setupFlow.handleSubmit("/cancel");
			return { consume: true };
		}
		void shutdown(0);
		return { consume: true };
	}
	if (matchesKey(data, Key.escape) && setupFlow.isWaitingForInput()) {
		setupFlow.handleSubmit("/cancel");
		return { consume: true };
	}
	const commandInput = handleCommandTypeaheadInput(data);
	if (commandInput !== undefined) return commandInput;
	const transcriptInput = handleTranscriptViewportGlobalInput(data);
	if (transcriptInput !== undefined) return transcriptInput;
	if (mouse !== undefined) return { consume: true };
	const rewritten = rewriteDroppedPaste(data);
	return rewritten === data ? undefined : { data: rewritten };
});
uiReady = true;
startBrainHealthMonitor();
refreshStatus("ready");
tui.start();
enableClankyMouseTracking();

try {
	await new Promise<void>(() => {});
} finally {
	stopBrainHealthMonitor();
	disableClankyMouseTracking();
	tui.stop();
	await reportClankyFaceToHerdr("unknown", "Clanky face stopped");
	await stopCallbackProxy();
	if (ownsServer) await stopServer();
}

function createAttachmentAwareClient(client: Client): Client {
	const wrapped = {
		fetch(path: string, init?: RequestInit): Promise<Response> {
			return client.fetch(path, init);
		},
		health() {
			return client.health();
		},
		info() {
			return client.info();
		},
		session(state?: SessionState | string): ClientSession {
			return createAttachmentAwareSession(client.session(state));
		},
	};
	return wrapped as unknown as Client;
}

function createAttachmentAwareSession(session: ClientSession): ClientSession {
	const wrapped = {
		get state() {
			return session.state;
		},
		async send<TOutput = unknown>(input: SendTurnInput<TOutput>) {
			return await session.send<TOutput>(await prepareAttachmentSendInput(input));
		},
		stream(options?: StreamOptions) {
			return session.stream(options);
		},
	};
	return wrapped as unknown as ClientSession;
}

async function prepareAttachmentSendInput<TOutput>(input: SendTurnInput<TOutput>): Promise<SendTurnInput<TOutput>> {
	if (typeof input === "string") {
		const message = await buildTuiAttachmentMessage(input, { cwd: REPO });
		return message === input ? input : ({ message } as SendTurnInput<TOutput>);
	}
	if (typeof input.message !== "string") return input;
	const message = await buildTuiAttachmentMessage(input.message, { cwd: REPO });
	if (message === input.message) return input;
	return { ...input, message } as SendTurnInput<TOutput>;
}

function buildClankyPromptCommands(): ClankyPromptCommandSpec[] {
	return [
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
			name: "clear",
			aliases: ["cls"],
			description: "Clear the on-screen transcript (keeps the current session)",
			takesArgument: false,
			build: () => ({ type: "clear" }),
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
			name: "discord-scope",
			aliases: ["discord", "scope"],
			description: "Open Discord reply-scope configuration",
			argumentHint: "[interactive|status|guilds|channels|add|remove|clear|dms]",
			takesArgument: true,
			build: (argument) => ({ type: "extension", name: "discord-scope", argument }),
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
			argumentHint: "[model-id|status|unset]",
			takesArgument: true,
			build: (argument) => ({ type: "extension", name: "image-model", argument }),
		},
		{
			name: "vision-model",
			aliases: ["vision"],
			description: "Set the visual inspection model for media_inspect",
			argumentHint: "[model-id|local <model-id>|openai <model-id>|unset|status]",
			takesArgument: true,
			build: (argument) => ({ type: "extension", name: "vision-model", argument }),
		},
		{
			name: "attachments",
			aliases: [],
			description: "Show local file attachment syntax",
			takesArgument: false,
			build: () => ({ type: "extension", name: "attachments", argument: "" }),
		},
		{
			name: "pet",
			aliases: [],
			description: "Toggle the petdex desktop pet that mirrors Clanky's activity",
			argumentHint: "[on|off|status]",
			takesArgument: true,
			build: (argument) => ({ type: "extension", name: "pet", argument }),
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
					name: "trace",
					aliases: [],
				description: "Show compact per-turn stream traces",
			argumentHint: "[status|off|no-reply|all]",
			takesArgument: true,
			build: (argument) => ({ type: "extension", name: "trace", argument }),
		},
		{
			name: "header",
			aliases: ["banner"],
			description: "Toggle the sticky Clanky header",
			argumentHint: "[on|off|toggle|status]",
			takesArgument: true,
			build: (argument) => ({ type: "extension", name: "header", argument }),
		},
		{
			name: "status",
			aliases: [],
			description: "Show model and Discord gateway status",
			takesArgument: false,
			build: (argument) => ({ type: "extension", name: "status", argument }),
		},
		{
			name: "exit",
			aliases: ["quit"],
			description: "Quit the face",
			takesArgument: false,
			build: () => ({ type: "exit" }),
		},
	];
}

type FlowHost = {
	insertMarkdown(text: string): FaceBlockHandle;
	setStatus(message: string): void;
};

function createFaceRenderSink(): FaceRenderSink {
	return {
		insertMarkdown,
		setLoaderMessage(message: string): void {
			activeLoader?.setMessage(message);
		},
		setStatus(message: string): void {
			refreshStatus(message);
		},
	};
}

function createFlowHost(): FlowHost {
	return {
		insertMarkdown,
		setStatus: refreshStatus,
	};
}

function openCommandPalette(): void {
	closeCommandPalette();
	const workbench = new ClankyCommandWorkbench(COMMANDS, {
		onCancel: closeCommandPalette,
		onRender: () => tui.requestRender(),
		onSubmit(text): void {
			closeCommandPalette();
			editor.setText(text);
			refreshCommandSurface(text);
			tui.setFocus(editor);
		},
	}, commandUiTheme, clankyCommandFilterFromText(editor.getText()));
	commandPaletteOverlay = tui.showOverlay(workbench, {
		anchor: "bottom-center",
		maxHeight: "70%",
		margin: { bottom: 3, left: 2, right: 2 },
		width: "92%",
	});
	tui.requestRender();
}

function closeCommandPalette(): void {
	const handle = commandPaletteOverlay;
	commandPaletteOverlay = undefined;
	if (handle !== undefined) handle.hide();
	tui.setFocus(editor);
	tui.requestRender();
}

function toggleTranscriptFocus(): void {
	if (transcriptViewport.focused) tui.setFocus(editor);
	else tui.setFocus(transcriptViewport);
	refreshStatusView();
	tui.requestRender();
}

function handleTranscriptSelectionMouse(mouse: ClankySgrMouseEvent): void {
	if (!isClankyLeftMouseButton(mouse)) return;
	if (mouse.kind === "press") {
		const target = transcriptMouseTarget(mouse);
		if (target.inside) {
			transcriptViewport.selectionPress(target.row, target.col);
			transcriptSelectionActive = true;
		} else {
			transcriptViewport.clearSelection();
			transcriptSelectionActive = false;
		}
		tui.requestRender();
		return;
	}
	if (mouse.kind === "drag") {
		if (!transcriptSelectionActive) return;
		const target = transcriptMouseTarget(mouse);
		transcriptViewport.selectionDrag(target.row, target.col);
		tui.requestRender();
		return;
	}
	// release
	if (!transcriptSelectionActive) return;
	transcriptSelectionActive = false;
	if (transcriptViewport.hasSelection()) void copyTranscriptSelection();
	else transcriptViewport.clearSelection();
	tui.requestRender();
}

function transcriptMouseTarget(mouse: ClankySgrMouseEvent): ReturnType<typeof resolveClankyTranscriptMouseTarget> {
	const width = tui.terminal.columns;
	const belowRows = status.render(width).length + commandTypeaheadPanel.render(width).length + editor.render(width).length;
	return resolveClankyTranscriptMouseTarget({
		bannerRows: banner.render(width).length,
		belowRows,
		mouseCol: mouse.col,
		mouseRow: mouse.row,
		terminalRows: tui.terminal.rows,
		transcriptRows: maxTranscriptRows(width),
	});
}

async function copyTranscriptSelection(): Promise<void> {
	const text = transcriptViewport.getSelectedText();
	if (text.length === 0) return;
	try {
		await writeClankyClipboard(text, (chunk) => tui.terminal.write(chunk));
	} catch {
		return;
	}
}

function isTranscriptNavigationInput(data: string): boolean {
	return (
		matchesKey(data, Key.up) ||
		matchesKey(data, Key.down) ||
		matchesKey(data, Key.pageUp) ||
		matchesKey(data, Key.pageDown) ||
		matchesKey(data, Key.home) ||
		matchesKey(data, Key.end) ||
		matchesKey(data, Key.enter) ||
		matchesKey(data, Key.space) ||
		data === "\r" ||
		data === " "
	);
}

function handleTranscriptViewportGlobalInput(data: string): { consume: true } | undefined {
	if (!shouldRouteClankyTranscriptGlobalInput(data, {
		commandPaletteFocused: commandPaletteOverlay?.isFocused() === true,
		editorAutocompleteOpen: editor.isShowingAutocomplete(),
		editorText: editor.getText(),
		setupWaiting: setupFlow.isWaitingForInput(),
		transcriptFocused: transcriptViewport.focused,
	})) {
		return undefined;
	}
	if (!transcriptViewport.handleGlobalInput(data)) return undefined;
	tui.requestRender();
	return { consume: true };
}

function handleCommandTypeaheadInput(data: string): { consume?: boolean; data?: string } | undefined {
	if (setupFlow.isWaitingForInput() || commandPaletteOverlay?.isFocused() === true) return undefined;
	const state = commandTypeaheadState;
	if (state === undefined || state.dismissed) return undefined;
	const selected = selectedClankyCommandTypeahead(state);
	const hasSelection = selected !== undefined;
	const listOpen = isClankyCommandTypeaheadOpen(state);
	const exact = isExactClankyCommandTypeahead(state);

	if (listOpen && matchesKey(data, Key.up)) {
		setCommandTypeaheadState(moveClankyCommandTypeaheadSelection(state, -1));
		return { consume: true };
	}
	if (listOpen && matchesKey(data, Key.down)) {
		setCommandTypeaheadState(moveClankyCommandTypeaheadSelection(state, 1));
		return { consume: true };
	}
	if ((listOpen || exact || state.matches.length === 0) && matchesKey(data, Key.escape)) {
		setCommandTypeaheadState(dismissClankyCommandTypeahead(state));
		return { consume: true };
	}
	if (hasSelection && (matchesKey(data, Key.tab) || data === "\t")) {
		const text = clankyCommandCompletion(selected);
		editor.setText(text);
		refreshCommandSurface(text);
		return { consume: true };
	}
	if (hasSelection && listOpen && (matchesKey(data, Key.enter) || data === "\r")) {
		const text = clankyCommandCompletion(selected).trimEnd();
		editor.setText(text);
		refreshCommandSurface(text);
		return undefined;
	}

	return undefined;
}

function setCommandTypeaheadState(state: ClankyCommandTypeaheadState | undefined): void {
	commandTypeaheadState = state;
	commandTypeaheadPanel.setText(editor.getText(), state, setupFlow.isWaitingForInput());
	tui.requestRender();
}

function createSetupFlow(host: FlowHost): SetupFlowController {
	let cancelActivePrompt: (() => void) | undefined;
	const interruptResolvers = new Set<() => void>();

	function handleSubmit(text: string): boolean {
		const trimmed = text.trim();
		if (trimmed !== "/cancel") return false;
		cancelActivePrompt?.();
		for (const resolve of interruptResolvers) resolve();
		interruptResolvers.clear();
		refreshStatusView();
		refreshCommandSurface(editor.getText());
		host.setStatus("cancelled");
		return true;
	}

	async function readTextOverlay(
		options: Parameters<SetupFlow["readText"]>[0],
		error: string | undefined,
		defaultValue: string | undefined,
	): Promise<string | undefined> {
		return await new Promise<string | undefined>((resolve) => {
			let settled = false;
			let handle: OverlayHandle | undefined;
			const finish = (value: string | undefined): void => {
				if (settled) return;
				settled = true;
				if (cancelActivePrompt === cancel) cancelActivePrompt = undefined;
				handle?.hide();
				tui.setFocus(editor);
				refreshStatusView();
				refreshCommandSurface(editor.getText());
				tui.requestRender();
				resolve(value);
			};
			const cancel = (): void => finish(undefined);
			cancelActivePrompt = cancel;
			refreshStatusView();
			refreshCommandSurface(editor.getText());
			const prompt = new InteractiveTextPrompt({
				defaultValue,
				error,
				message: options.message,
				onCancel: cancel,
				onRender: () => tui.requestRender(),
				onSubmit: (value) => finish(value),
				placeholder: options.placeholder,
			});
			handle = tui.showOverlay(prompt, setupOverlayOptions("center"));
			handle.focus();
			tui.requestRender();
		});
	}

	async function readSelectOverlay(options: Parameters<SetupFlow["readSelect"]>[0]): Promise<string[] | undefined> {
		return await new Promise<string[] | undefined>((resolve) => {
			let settled = false;
			let handle: OverlayHandle | undefined;
			const finish = (values: readonly string[] | undefined): void => {
				if (settled) return;
				settled = true;
				if (cancelActivePrompt === cancel) cancelActivePrompt = undefined;
				handle?.hide();
				tui.setFocus(editor);
				refreshStatusView();
				refreshCommandSurface(editor.getText());
				tui.requestRender();
				resolve(values === undefined ? undefined : [...values]);
			};
			const cancel = (): void => finish(undefined);
			cancelActivePrompt = cancel;
			refreshStatusView();
			refreshCommandSurface(editor.getText());
			const prompt = new InteractiveSelectPrompt({
				initialValue: options.initialValue,
				initialValues: options.initialValues,
				kind: options.kind,
				message: options.message,
				onCancel: cancel,
				onRender: () => tui.requestRender(),
				onSubmit: (values) => finish(values),
				options: options.options.map(toInteractivePromptOption),
				required: options.required,
				theme: selectListTheme,
			});
			handle = tui.showOverlay(prompt, setupOverlayOptions("center"));
			handle.focus();
			tui.requestRender();
		});
	}

	return {
		begin(title: string): void {
			host.setStatus(title);
		},
		end(): void {
			host.setStatus("ready");
		},
		renderOutput(text: string): void {
			const summary = firstMeaningfulLine(text);
			if (summary !== undefined) host.setStatus(summary);
		},
		renderLine(text: string, tone: FlowLineTone = "info"): void {
			const summary = firstMeaningfulLine(text);
			if (summary !== undefined) host.setStatus(`${titleCaseConnection(tone)}: ${summary}`);
		},
		setStatus(statusText: string | undefined): void {
			host.setStatus(statusText ?? "ready");
		},
		async readText(options): Promise<string | undefined> {
			let defaultValue = options.defaultValue;
			let error: string | undefined;
			for (;;) {
				const submitted = await readTextOverlay(options, error, defaultValue);
				if (submitted === undefined) return undefined;
				const value = submitted.trim().length === 0 && options.defaultValue !== undefined ? options.defaultValue : submitted;
				error = options.validate?.(value);
				if (error === undefined) return value;
				defaultValue = value;
			}
		},
		async readSelect(options): Promise<string[] | undefined> {
			return await readSelectOverlay(options);
		},
		waitForInterrupt() {
			let resolvePromise: (() => void) | undefined;
			const promise = new Promise<void>((resolve) => {
				resolvePromise = resolve;
				interruptResolvers.add(resolve);
				refreshStatusView();
				refreshCommandSurface(editor.getText());
			});
			return {
				promise,
				dispose(): void {
					if (resolvePromise !== undefined) interruptResolvers.delete(resolvePromise);
					refreshStatusView();
					refreshCommandSurface(editor.getText());
				},
			};
		},
		handleSubmit,
		isWaitingForInput(): boolean {
			return cancelActivePrompt !== undefined || interruptResolvers.size > 0;
		},
	};
}

function setupOverlayOptions(anchor: "center" | "bottom-center"): Parameters<TUI["showOverlay"]>[1] {
	return {
		anchor,
		margin: { bottom: 3, left: 2, right: 2, top: 2 },
		maxHeight: "70%",
		minWidth: 48,
		width: "88%",
	};
}

function toInteractivePromptOption(option: MenuOption): InteractivePromptOption {
	return {
		description: option.description,
		hint: option.hint,
		label: option.label,
		value: option.value,
	};
}

function insertMarkdown(text: string): FaceBlockHandle {
	const component = new ClankyTranscriptMarkdownBlock(text, {
		bold: ansi.bold,
		cyan: ansi.cyan,
		dim: ansi.dim,
		green: ansi.green,
		markdown: markdownTheme,
		red: ansi.red,
		yellow: ansi.yellow,
	});
	insertTranscript(component);
	tui.requestRender();
	return {
		setMarkdown(markdown: string): void {
			component.setMarkdown(markdown);
			tui.requestRender();
		},
	};
}

function insertCommandResult(prompt: string, message: string, tone: CommandLogTone): void {
	const component = new Text(formatCommandLogText(prompt, message, tone), 1, 0);
	insertTranscript(component);
	tui.requestRender();
}

function formatCommandLogText(prompt: string, message: string, tone: CommandLogTone): string {
	const command = slashCommandLabel(prompt);
	const status = tone === "error" ? ansi.red("error") : ansi.green("done");
	const header = `${status} ${ansi.cyan(command)} ${ansi.dim("command")}`;
	const body = commandResultBodyLines(message);
	return [header, ...body.map((line) => `  ${styleCommandResultLine(line)}`)].join("\n");
}

function slashCommandLabel(prompt: string): string {
	const token = prompt.trim().split(/\s+/u)[0];
	return token?.startsWith("/") === true ? token : "/command";
}

function commandResultBodyLines(message: string): string[] {
	const normalized = message.trim().replace(/\n{3,}/gu, "\n\n");
	if (normalized.length === 0) return [];
	const lines = normalized.split(/\r?\n/u);
	const maxLines = 8;
	if (lines.length <= maxLines) return lines;
	return [...lines.slice(0, maxLines - 1), ansi.dim(`... ${lines.length - maxLines + 1} more lines`)];
}

function styleCommandResultLine(line: string): string {
	if (line.trim().length === 0) return "";
	const heading = /^([A-Za-z][A-Za-z0-9 /_-]{0,30}:)(.*)$/u.exec(line);
	if (heading !== null) return `${ansi.yellow(heading[1] ?? "")}${heading[2] ?? ""}`;
	if (/^(Usage|Examples):$/u.test(line)) return ansi.dim(line);
	return line;
}

function firstMeaningfulLine(text: string): string | undefined {
	const line = text.split(/\r?\n/u).map((entry) => entry.trim()).find((entry) => entry.length > 0);
	return line === undefined ? undefined : truncate(line, 96);
}

function insertTranscript(component: Component, options?: ClankyTranscriptBlockOptions): ClankyTranscriptBlockHandle {
	return transcriptViewport.addChild(component, options);
}

function maxTranscriptRows(width: number): number {
	const reservedRows =
		banner.render(width).length +
		status.render(width).length +
		commandTypeaheadPanel.render(width).length +
		editor.render(width).length;
	return resolveClankyTranscriptRows({
		minRows: MIN_TRANSCRIPT_ROWS,
		reservedRows,
		terminalRows: tui.terminal.rows,
	});
}

function maxCommandTypeaheadRows(width = tui.terminal.columns): number {
	const reservedRows =
		banner.render(width).length +
		status.render(width).length +
		editor.render(width).length +
		MIN_TRANSCRIPT_ROWS;
	return resolveClankyCommandRows({
		maxRows: 10,
		reservedRows,
		terminalRows: tui.terminal.rows,
	});
}

async function seedPromptHistory(targetEditor: Editor): Promise<void> {
	const entries = await readPromptHistoryFile(clankyPromptHistoryPath());
	for (const entry of entries) targetEditor.addToHistory(entry);
}

function rememberPrompt(prompt: string): void {
	editor.addToHistory(prompt);
	void appendPromptHistoryEntry(clankyPromptHistoryPath(), prompt).catch(() => undefined);
}

async function submitEditorText(rawPrompt: string): Promise<void> {
	const prompt = rawPrompt.trim();
	if (prompt.length === 0) return;
	// Slash commands stay usable while a turn streams, so they are never gated on
	// isResponding. A second plain prompt would collide with the active turn, so
	// restore the text rather than dropping what the user typed.
	if (prompt.startsWith("/")) {
		rememberPrompt(prompt);
		await handleSlashPrompt(prompt);
		return;
	}
	if (isResponding) {
		editor.setText(rawPrompt);
		refreshCommandSurface(rawPrompt);
		return;
	}
	rememberPrompt(prompt);
	await submitPrompt(prompt);
}

async function handleSlashPrompt(prompt: string): Promise<void> {
	const parsed = parsePromptCommand(prompt);
	if (typeof parsed === "string") {
		insertCommandResult(prompt, parsed, "error");
		return;
	}
	const outcome = await handleClankyCommand(parsed, commandRenderer);
	if (outcome.clearTranscript === true) {
		transcriptViewport.clear();
		faceRenderer.resetTurn();
		tui.requestRender();
	}
	if (outcome.message !== undefined && outcome.message.length > 0) {
		insertCommandResult(prompt, outcome.message, outcome.message.toLowerCase().includes("unknown ") ? "error" : "success");
	}
	if (outcome.clearTranscript === true) {
		insertCommandResult(prompt, "Transcript cleared.", "success");
	}
	if (outcome.newSession === true) {
		if (isResponding) {
			insertCommandResult(prompt, "Clanky is still responding; wait for the current turn to finish before starting a new session.", "error");
		} else {
			session = client.session();
			faceRenderer.resetSession();
			insertCommandResult(prompt, "New session started.", "success");
		}
	}
	if (outcome.exit === true) await shutdown(0);
}

async function submitPrompt(prompt: string): Promise<void> {
	faceRenderer.resetTurn();
	isResponding = true;
	insertMarkdown(`**You**\n\n${prompt}`);
	const loader = new Loader(tui, ansi.cyan, ansi.dim, "Thinking...");
	activeLoader = loader;
	const loaderTranscript = insertTranscript(loader, { collapsible: false });
	loader.start();
	refreshStatus("thinking");
	tui.requestRender();

	try {
		await consumeTurn(session.send(prompt));
		const notice = faceRenderer.noticeForCompletedTurn(turnTraceMode);
		if (notice !== undefined) insertMarkdown(`**Notice**\n\n${notice}`);
	} catch (error) {
		insertMarkdown(`**Error**\n\n${formatError(error)}`);
	} finally {
		loader.stop();
		loaderTranscript.remove();
		if (activeLoader === loader) activeLoader = undefined;
		isResponding = false;
		refreshStatus("ready");
		tui.requestRender();
	}
}

async function consumeTurn(responsePromise: Promise<Awaited<ReturnType<ClientSession["send"]>>>): Promise<void> {
	const pendingInputRequests = new InputRequestQueue();
	const response = await responsePromise;
	for await (const event of response) {
		const result = faceRenderer.renderEvent(event);
		if (result.inputRequests.length > 0) pendingInputRequests.add(result.inputRequests);
		refreshStatus(statusLabelForEvent(event));
		tui.requestRender();
		if (result.terminal) break;
	}
	const requests = pendingInputRequests.drain();
	if (requests.length === 0) return;
		const inputResponses = await readInputResponses(requests);
		if (inputResponses.length === 0) return;
		faceRenderer.recordInputResponses(inputResponses);
		await consumeTurn(session.send({ inputResponses }));
	}

async function readInputResponses(requests: readonly InputRequest[]): Promise<InputResponse[]> {
	activeLoader?.setMessage("Waiting for input...");
	const responses: InputResponse[] = [];
	try {
		for (const request of requests) {
			const response = await readInputResponse(request);
			if (response === undefined) return [];
			responses.push(response);
		}
		return responses;
	} finally {
		activeLoader?.setMessage("Continuing...");
	}
}

async function readInputResponse(request: InputRequest): Promise<InputResponse | undefined> {
	const options = request.options ?? [];
	if (options.length > 0) {
		const selected = await setupFlow.readSelect({
			kind: "single",
			message: `${request.prompt}\n\n${formatInputRequests([request])}`,
			options: options.map((option) => ({
				value: option.id,
				label: option.label,
				description: option.description,
				hint: option.style,
			})),
			initialValue: options[0]?.id,
			required: request.display !== "text" && request.allowFreeform !== true,
		});
		if (selected === undefined) return undefined;
		const optionId = selected[0];
		if (optionId !== undefined) return { requestId: request.requestId, optionId };
		if (request.allowFreeform !== true) return defaultResponseForInputRequest(request);
	}
	const text = await setupFlow.readText({
		message: request.prompt,
		placeholder: "Type a response, or /cancel",
	});
	return text === undefined ? undefined : { requestId: request.requestId, text };
}

function parsePromptCommand(prompt: string): ClankyPromptCommand | string {
	const [rawName = "", ...rest] = prompt.slice(1).trim().split(/\s+/u);
	const name = rawName.toLowerCase();
	const spec = COMMANDS.find((command) => command.name === name || command.aliases.includes(name));
	if (spec === undefined) return `Unknown command "/${rawName}". Type /help for available commands.`;
	const argument = rest.join(" ").trim();
	if (!spec.takesArgument && argument.length > 0) return `/${spec.name} does not take an argument.`;
	return spec.build(argument);
}

async function handleClankyCommand(command: ClankyPromptCommand, renderer: CommandRenderer): Promise<PromptCommandOutcome> {
	switch (command.type) {
		case "help":
			return { message: formatHelp() };
		case "new":
			return { newSession: true };
		case "clear":
			return { clearTranscript: true };
		case "exit":
			return { exit: true };
		case "extension":
			return await handleExtensionCommand(command, renderer);
	}
	return { message: "Unknown command." };
}

async function handleExtensionCommand(command: ClankyExtensionCommand, renderer: CommandRenderer): Promise<PromptCommandOutcome> {
	switch (command.name) {
		case "discord-token":
			return { message: await setDiscordToken(command.argument, renderer.setupFlow) };
		case "discord-scope":
			return { message: await configureDiscordScope(command.argument, renderer.setupFlow) };
		case "login":
			return { message: await configureLogin(command.argument, renderer.setupFlow) };
		case "model":
			return { message: await configureModel(command.argument, renderer.setupFlow) };
		case "harness":
			return { message: await configureHarness(command.argument, renderer.setupFlow) };
		case "effort":
			return { message: await configureEffort(command.argument, renderer.setupFlow) };
		case "approvals":
			return { message: await configureApprovals(command.argument, renderer.setupFlow) };
		case "image-model":
			return { message: await configureImageModel(command.argument, renderer.setupFlow) };
		case "vision-model":
			return { message: await configureVisionModel(command.argument, renderer.setupFlow) };
		case "attachments":
			return { message: TUI_ATTACHMENT_HELP };
		case "pet":
			return { message: await configurePet(command.argument, renderer.setupFlow) };
		case "voice":
			return { message: await configureVoice(command.argument, renderer.setupFlow) };
		case "integrations":
			return { message: await configureIntegrations(command.argument, renderer.setupFlow) };
		case "mcp":
			return { message: await configureMcp(command.argument, renderer.setupFlow, renderer) };
		case "browser":
			return { message: await configureBrowserBridge(command.argument, renderer.setupFlow) };
		case "trace":
			return { message: await configureTrace(command.argument, renderer.setupFlow) };
		case "header":
			return { message: configureHeader(command.argument) };
		case "status":
			return { message: await statusText() };
	}
}

function formatHelp(): string {
	return [
		"Available commands:",
		"",
		...COMMANDS.map((command) => {
			const aliases = command.aliases.length === 0 ? "" : ` (${command.aliases.map((alias) => `/${alias}`).join(", ")})`;
			const hint = command.argumentHint === undefined ? "" : ` ${command.argumentHint}`;
			return `- /${command.name}${hint}${aliases} - ${command.description}`;
		}),
	].join("\n");
}

function statusLabelForEvent(event: HandleMessageStreamEvent): string {
	switch (event.type) {
		case "step.started":
			return `step ${event.data.stepIndex + 1}`;
		case "step.completed":
			return `step ${event.data.stepIndex + 1} completed`;
		case "session.waiting":
			return "waiting";
		case "session.completed":
			return "ready";
		case "session.failed":
			return "failed";
		default:
			return "streaming";
	}
}

function buildBannerFields(info: AgentInfoResult | undefined): BannerFields {
	const fields: BannerFields = {
		title: "Clanky",
		tagline: "eve conductor · herdr stage",
		hint: "/help for commands · ctrl+c to exit",
	};
	const modelId = bannerModelId(info);
	if (modelId !== undefined) fields.model = modelId;
	fields.cwd = displayHomePath(REPO);
	return fields;
}

function bannerModelId(info: AgentInfoResult | undefined): string | undefined {
	if (info === undefined) return undefined;
	let modelId = info.agent.model.id;
	if (info.agent.model.endpoint?.kind === "external" && info.agent.model.endpoint.provider === "ollama") {
		modelId = modelId.replace(/^ollama\//u, "");
	}
	return effortStatusSuffix.length > 0 ? `${modelId}${effortStatusSuffix}` : modelId;
}

function displayHomePath(path: string): string {
	const home = process.env.HOME;
	if (home !== undefined && home.length > 0 && (path === home || path.startsWith(`${home}/`))) {
		return `~${path.slice(home.length)}`;
	}
	return path;
}

function contextSizeFromInfo(info: AgentInfoResult | undefined): number | undefined {
	const tokens = info?.agent.model.contextWindowTokens;
	return typeof tokens === "number" && Number.isSafeInteger(tokens) && tokens > 0 ? tokens : undefined;
}

async function refreshEffortStatusSuffix(): Promise<void> {
	const config = await readConfig();
	const effort =
		config.provider === "codex" ? config.codexEffort : config.provider === "local" ? config.localEffort : undefined;
	effortStatusSuffix = effort !== undefined && effort.length > 0 ? ` (${effort} effort)` : "";
}

function refreshStatus(label: string): void {
	currentStatusLabel = label;
	refreshStatusView();
}

function refreshStatusView(): void {
	status.setText(formatStatusText(currentStatusLabel));
	tui.requestRender();
}

function refreshBannerView(): void {
	banner.setFields(buildBannerFields(latestInfo));
	tui.requestRender();
}

function refreshBrainHealthView(): void {
	if (!uiReady) return;
	refreshStatusView();
}

function startBrainHealthMonitor(): void {
	if (brainHealthMonitor !== undefined) return;
	brainHealthMonitor = setInterval(() => {
		void refreshBrainHealth();
	}, BRAIN_HEALTH_POLL_MS);
}

function stopBrainHealthMonitor(): void {
	if (brainHealthMonitor === undefined) return;
	clearInterval(brainHealthMonitor);
	brainHealthMonitor = undefined;
}

async function refreshBrainHealth(): Promise<void> {
	if (brainRestartInProgress || brainHealthRefreshRunning) return;
	brainHealthRefreshRunning = true;
	const generation = brainHealthGeneration;
	try {
		const previousState = brainHealth.state;
		const health = await fetchBrainHealth();
		if (brainRestartInProgress || generation !== brainHealthGeneration) return;
		setBrainHealth(health);
		if (health.state !== "healthy") return;
		if (latestInfo !== undefined && previousState === "healthy") return;
		const info = await fetchInfo({ healthGeneration: generation });
		if (brainRestartInProgress || generation !== brainHealthGeneration) return;
		if (info !== undefined) updateLatestInfo(info);
	} finally {
		brainHealthRefreshRunning = false;
		refreshBrainHealthView();
	}
}

function updateLatestInfo(info: AgentInfoResult): void {
	latestInfo = info;
	currentContextSize = contextSizeFromInfo(info);
	if (!uiReady) return;
	refreshBannerView();
	refreshStatusView();
}

function refreshCommandSurface(text: string): void {
	const disabled = setupFlow.isWaitingForInput();
	commandTypeaheadState = disabled ? undefined : clankyCommandTypeaheadFor(COMMANDS, text, commandTypeaheadState);
	commandTypeaheadPanel.setText(text, commandTypeaheadState, disabled);
	tui.requestRender();
}

function formatStatusText(label: string): string {
	const model = bannerModelId(latestInfo) ?? "model unknown";
	const responseState = isResponding && label !== "thinking" && !label.startsWith("step ") ? "responding" : "";
	const setupState = setupFlow.isWaitingForInput() ? "setup input" : "";
	const authState = connectionAuthPendingCount > 0 ? `auth pending ${connectionAuthPendingCount}` : "";
	const focusState = transcriptViewport.focused ? "transcript nav" : "";
	const brainState = formatBrainHealthStatus(brainHealth);
	const parts = [
		"Clanky",
		label,
		responseState,
		setupState,
		authState,
		focusState,
		model,
		formatContextUsage(faceRenderer.lastUsage, currentContextSize),
		`events ${faceRenderer.eventCount}`,
		brainHost.replace(/^https?:\/\//u, ""),
	]
		.filter((part) => part.length > 0)
		.map((part) => ansi.dim(part));
	if (brainState.length > 0) parts.splice(2, 0, brainState);
	return parts.join("  ·  ");
}

function formatBrainHealthStatus(health: BrainHealthState): string {
	switch (health.state) {
		case "healthy":
			return "";
		case "unknown":
			return ansi.dim("brain unknown");
		case "restarting":
			return ansi.yellow("brain restarting");
		case "unhealthy":
			return ansi.yellow(`brain unhealthy ${health.status}`);
		case "down":
			return ansi.red("brain down");
	}
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

async function shutdown(exitCode: number): Promise<void> {
	if (shutdownStarted) return;
	shutdownStarted = true;
	try {
		if (runningTurn !== undefined) await runningTurn.catch(() => undefined);
		stopBrainHealthMonitor();
		disableClankyMouseTracking();
		tui.stop();
		await reportClankyFaceToHerdr("unknown", "Clanky face stopped");
		await stopCallbackProxy();
		if (ownsServer) await stopServer();
	} finally {
		process.exit(exitCode);
	}
}

function enableClankyMouseTracking(): void {
	if (mouseTrackingEnabled) return;
	mouseTrackingEnabled = true;
	tui.terminal.write(CLANKY_MOUSE_TRACKING_ENABLE);
}

function disableClankyMouseTracking(): void {
	if (!mouseTrackingEnabled) return;
	mouseTrackingEnabled = false;
	tui.terminal.write(CLANKY_MOUSE_TRACKING_DISABLE);
}

async function setDiscordToken(argument: string, flow: SetupFlow | undefined): Promise<string> {
	const args = splitArgs(argument);
	const token = args.find((arg) => !arg.startsWith("--"));
	if (token === undefined) {
		if (flow === undefined) return "Usage: /discord-token <token> [--user-token] [--voice]";
		const update = await promptDiscordToken(flow);
		if (update === undefined) return "/discord-token cancelled.";
		await writeEnv(update.updates);
		return await restartBrainMessage(update.message);
	}

	const update = buildDiscordTokenUpdate(token, args.includes("--user-token") ? "user-token" : "bot-token", args.includes("--voice"));
	await writeEnv(update.updates);
	return await restartBrainMessage(update.message);
}

async function promptDiscordToken(flow: SetupFlow): Promise<DiscordTokenUpdate | undefined> {
	flow.begin("Set Discord credential");
	try {
		const kind = await selectOne(flow, "Choose the Discord credential kind.", DISCORD_CREDENTIAL_KIND_OPTIONS, "bot-token");
		if (kind !== "bot-token" && kind !== "user-token") return undefined;
		const voiceValue = await selectOne(flow, "Enable Discord voice with this credential?", DISCORD_TOKEN_VOICE_OPTIONS, "off");
		const voice = parseOnOff(voiceValue);
		if (voice === undefined) return undefined;
		const token = await flow.readText({
			message: "Paste the Discord credential.",
			placeholder: kind === "user-token" ? "Discord user token" : "Discord bot token",
			validate: requiredDiscordTokenText,
		});
		return token === undefined ? undefined : buildDiscordTokenUpdate(token, kind, voice);
	} finally {
		flow.end({ preserveDiagnostics: false });
	}
}

function buildDiscordTokenUpdate(token: string, kind: "bot-token" | "user-token", voice: boolean): DiscordTokenUpdate {
	const updates: Record<string, string> = {
		DISCORD_BOT_TOKEN: token.trim(),
		CLANKY_DISCORD_CREDENTIAL_KIND: kind,
		CLANKY_DISCORD_PRESENCE: "1",
		CLANKY_DISCORD_VOICE: voice ? "1" : "0",
	};
	return { updates, message: "Discord credential saved" };
}

async function configureDiscordScope(argument: string, flow: SetupFlow | undefined): Promise<string> {
	const args = splitArgs(argument);
	const command = args[0]?.toLowerCase() ?? "status";
	const config = await readConfig();
	if (args.length === 0 || command === "interactive" || command === "edit" || command === "configure") {
		if (flow === undefined) return discordScopeStatusText(config);
		return await configureDiscordScopeInteractive(flow, config);
	}
	if (command === "status" || command === "show" || command === "view") return discordScopeStatusText(config);
	if (command === "help") return discordScopeUsage();

	if (command === "dms" || command === "dm" || command === "allow-dms") {
		const value = parseOnOff(args[1]);
		if (value === undefined) {
			if (flow === undefined) return `Usage: /discord-scope dms on|off\n\n${discordScopeStatusText(config)}`;
			return await configureDiscordScopeFocused(flow, config, "Configure Discord DMs", () => promptDiscordScopeDms(flow, config));
		}
		return await saveDiscordScopeUpdate(buildDiscordScopeDmsUpdate(value));
	}

	if (command === "clear" || command === "reset") {
		if (args[1] === undefined && flow !== undefined) {
			return await configureDiscordScopeFocused(flow, config, "Clear Discord reply scope", () => promptDiscordScopeClear(flow));
		}
		const target = args[1]?.toLowerCase() ?? "all";
		const removals = discordScopeRemovalKeys(target);
		if (removals === undefined) {
			if (flow === undefined) return `Unknown Discord scope target "${args[1]}". Use guilds, channels, dms, or all.`;
			return await configureDiscordScopeFocused(flow, config, "Clear Discord reply scope", () => promptDiscordScopeClear(flow));
		}
		return await saveDiscordScopeUpdate(buildDiscordScopeClearUpdate(removals));
	}

	if (command === "add" || command === "remove") {
		const target = parseDiscordScopeTarget(args[1]);
		if (target === undefined) {
			if (flow === undefined) return `Usage: /discord-scope ${command} guilds|channels <id...>`;
			return await configureDiscordScopeFocused(flow, config, "Update Discord allowlist", async () => {
				const selectedTarget = parseDiscordScopeTarget(
					await selectOne(flow, "Choose which allowlist to update.", DISCORD_SCOPE_TARGET_OPTIONS, "channels"),
				);
				if (selectedTarget === undefined) return undefined;
				return command === "add"
					? await promptDiscordScopeAdd(flow, config, selectedTarget)
					: await promptDiscordScopeRemove(flow, config, selectedTarget);
			});
		}
		const ids = parseDiscordScopeIds(args.slice(2));
		if (typeof ids === "string") {
			if (flow === undefined) return ids;
			return await configureDiscordScopeFocused(flow, config, `Update Discord ${target}`, () =>
				command === "add" ? promptDiscordScopeAdd(flow, config, target) : promptDiscordScopeRemove(flow, config, target),
			);
		}
		return await saveDiscordScopeUpdate(buildDiscordScopeAddRemoveUpdate(config, target, ids, command));
	}

	const target = parseDiscordScopeTarget(command);
	if (target !== undefined) {
		const rest = args.slice(1);
		if (rest[0]?.toLowerCase() === "clear" || rest[0]?.toLowerCase() === "reset") {
			return await saveDiscordScopeUpdate(buildDiscordScopeClearUpdate([discordScopeEnvForTarget(target)], `Discord ${target} allowlist cleared`));
		}
		const ids = parseDiscordScopeIds(rest);
		if (typeof ids === "string") {
			if (flow === undefined) return ids;
			return await configureDiscordScopeFocused(flow, config, `Set Discord ${target}`, () =>
				promptDiscordScopeReplace(flow, config, target),
			);
		}
		return await saveDiscordScopeUpdate(buildDiscordScopeSetIdsUpdate(target, ids));
	}

	return `Unknown Discord scope command "${command}".\n\n${discordScopeUsage()}`;
}

async function configureDiscordScopeFocused(
	flow: SetupFlow,
	config: ClankyConfig,
	title: string,
	prompt: () => Promise<DiscordScopeUpdate | string | undefined>,
): Promise<string> {
	let update: DiscordScopeUpdate | string | undefined;
	flow.begin(title);
	try {
		flow.renderOutput(formatDiscordScopeConfig(config));
		update = await prompt();
	} finally {
		flow.end({ preserveDiagnostics: false });
	}
	if (update === undefined) return "/discord-scope cancelled.";
	if (typeof update === "string") return update;
	return await saveDiscordScopeUpdate(update);
}

async function configureDiscordScopeInteractive(flow: SetupFlow, config: ClankyConfig): Promise<string> {
	let update: DiscordScopeUpdate | string | undefined;
	flow.begin("Configure Discord reply scope");
	try {
		flow.renderOutput(formatDiscordScopeConfig(config));
		const action = await selectOne(flow, "Choose what to change.", DISCORD_SCOPE_ACTION_OPTIONS, "status");
		switch (action) {
			case "status":
				update = discordScopeStatusText(config);
				break;
			case "set-guilds":
				update = await promptDiscordScopeReplace(flow, config, "guilds");
				break;
			case "set-channels":
				update = await promptDiscordScopeReplace(flow, config, "channels");
				break;
			case "add-guilds":
				update = await promptDiscordScopeAdd(flow, config, "guilds");
				break;
			case "add-channels":
				update = await promptDiscordScopeAdd(flow, config, "channels");
				break;
			case "remove-guilds":
				update = await promptDiscordScopeRemove(flow, config, "guilds");
				break;
			case "remove-channels":
				update = await promptDiscordScopeRemove(flow, config, "channels");
				break;
			case "dms":
				update = await promptDiscordScopeDms(flow, config);
				break;
			case "clear":
				update = await promptDiscordScopeClear(flow);
				break;
			default:
				update = undefined;
				break;
		}
	} finally {
		flow.end({ preserveDiagnostics: false });
	}
	if (update === undefined) return "/discord-scope cancelled.";
	if (typeof update === "string") return update;
	return await saveDiscordScopeUpdate(update);
}

async function promptDiscordScopeReplace(
	flow: SetupFlow,
	config: ClankyConfig,
	target: DiscordScopeTarget,
): Promise<DiscordScopeUpdate | string | undefined> {
	const current = discordScopeIdsForTarget(config, target).join(",");
	const label = target === "guilds" ? "server" : "channel/thread";
	const value = await flow.readText({
		message: `Set allowed Discord ${target}.`,
		defaultValue: current,
		placeholder: `${label} ids separated by spaces or commas; blank means any`,
		validate: (raw) => validateDiscordScopeIdText(raw, true),
	});
	if (value === undefined) return undefined;
	const ids = parseDiscordScopeIdText(value, true);
	if (typeof ids === "string") return ids;
	return buildDiscordScopeSetIdsUpdate(target, ids);
}

async function promptDiscordScopeAdd(
	flow: SetupFlow,
	config: ClankyConfig,
	target: DiscordScopeTarget,
): Promise<DiscordScopeUpdate | string | undefined> {
	const label = target === "guilds" ? "server" : "channel/thread";
	const value = await flow.readText({
		message: `Add allowed Discord ${target}.`,
		placeholder: `${label} ids separated by spaces or commas`,
		validate: (raw) => validateDiscordScopeIdText(raw, false),
	});
	if (value === undefined) return undefined;
	const ids = parseDiscordScopeIdText(value, false);
	if (typeof ids === "string") return ids;
	return buildDiscordScopeAddRemoveUpdate(config, target, ids, "add");
}

async function promptDiscordScopeRemove(
	flow: SetupFlow,
	config: ClankyConfig,
	target: DiscordScopeTarget,
): Promise<DiscordScopeUpdate | string | undefined> {
	const existing = discordScopeIdsForTarget(config, target);
	if (existing.length === 0) return `Discord ${target} allowlist is already empty.`;
	const selected = await flow.readSelect({
		kind: "multi",
		message: `Choose Discord ${target} to remove.`,
		options: existing.map((id) => ({ value: id, label: id })),
		initialValues: [],
		required: false,
	});
	if (selected === undefined) return undefined;
	if (selected.length === 0) return `No Discord ${target} selected.`;
	return buildDiscordScopeAddRemoveUpdate(config, target, [...selected], "remove");
}

async function promptDiscordScopeDms(
	flow: SetupFlow,
	config: ClankyConfig,
): Promise<DiscordScopeUpdate | undefined> {
	const selected = await selectOne(
		flow,
		"Should Clanky respond in DMs?",
		DISCORD_DM_OPTIONS,
		configBooleanDefaultTrue(config.discordAllowDms) ? "on" : "off",
	);
	const enabled = parseOnOff(selected);
	return enabled === undefined ? undefined : buildDiscordScopeDmsUpdate(enabled);
}

async function promptDiscordScopeClear(flow: SetupFlow): Promise<DiscordScopeUpdate | undefined> {
	const target = await selectOne(flow, "Choose Discord scope settings to clear.", DISCORD_SCOPE_CLEAR_OPTIONS, "all");
	if (target === undefined) return undefined;
	const removals = discordScopeRemovalKeys(target);
	return removals === undefined ? undefined : buildDiscordScopeClearUpdate(removals);
}

async function saveDiscordScopeUpdate(update: DiscordScopeUpdate): Promise<string> {
	await updateEnv(update.updates, update.removals);
	return await discordScopeRestartMessage(update.message);
}

function buildDiscordScopeSetIdsUpdate(target: DiscordScopeTarget, ids: readonly string[]): DiscordScopeUpdate {
	const key = discordScopeEnvForTarget(target);
	return ids.length === 0
		? { updates: {}, removals: [key], message: `Discord ${target} allowlist cleared` }
		: {
				updates: { [key]: uniqueStrings(ids).join(",") },
				removals: [],
				message: `Discord ${target} allowlist saved`,
			};
}

function buildDiscordScopeAddRemoveUpdate(
	config: ClankyConfig,
	target: DiscordScopeTarget,
	ids: readonly string[],
	action: "add" | "remove",
): DiscordScopeUpdate {
	const existing = discordScopeIdsForTarget(config, target);
	const removeSet = new Set(ids);
	const next = action === "add" ? uniqueStrings([...existing, ...ids]) : existing.filter((id) => !removeSet.has(id));
	return {
		...buildDiscordScopeSetIdsUpdate(target, next),
		message: `Discord ${target} allowlist updated`,
	};
}

function buildDiscordScopeDmsUpdate(enabled: boolean): DiscordScopeUpdate {
	return {
		updates: { [DISCORD_SCOPE_ENV.dms]: enabled ? "1" : "0" },
		removals: [],
		message: "Discord DM scope saved",
	};
}

function buildDiscordScopeClearUpdate(removals: string[], message = "Discord reply scope cleared"): DiscordScopeUpdate {
	return { updates: {}, removals, message };
}

function discordScopeStatusText(config: ClankyConfig): string {
	return [
		formatDiscordScopeConfig(config),
		"",
		"Run /discord-scope to edit, or /discord-scope help for usage.",
	].join("\n");
}

function formatDiscordScopeConfig(config: ClankyConfig): string {
	return [
		"Discord reply scope:",
		`guilds: ${formatDiscordScopeList(config.discordAllowedGuildIds, "any server the token can see")}`,
		`channels: ${formatDiscordScopeList(config.discordAllowedChannelIds, "any channel in allowed servers")}`,
		`DMs: ${configBooleanDefaultTrue(config.discordAllowDms) ? "allowed" : "blocked"}`,
	].join("\n");
}

function discordScopeUsage(): string {
	return [
		"Usage: /discord-scope [status|guilds|channels|add|remove|clear|dms]",
		"Examples:",
		"/discord-scope guilds 866430493889134672",
		"/discord-scope channels 866430493889134675",
		"/discord-scope add channels 123456789012345678",
		"/discord-scope dms off",
	].join("\n");
}

async function discordScopeRestartMessage(prefix: string): Promise<string> {
	const message = await restartBrainMessage(prefix);
	return `${message}\n${discordScopeStatusText(await readConfig())}`;
}

type DiscordScopeTarget = "guilds" | "channels";

function parseDiscordScopeTarget(value: string | undefined): DiscordScopeTarget | undefined {
	const normalized = value?.toLowerCase();
	if (normalized === "guild" || normalized === "guilds" || normalized === "server" || normalized === "servers") {
		return "guilds";
	}
	if (normalized === "channel" || normalized === "channels" || normalized === "thread" || normalized === "threads") {
		return "channels";
	}
	return undefined;
}

function discordScopeEnvForTarget(target: DiscordScopeTarget): string {
	return target === "guilds" ? DISCORD_SCOPE_ENV.guilds : DISCORD_SCOPE_ENV.channels;
}

function discordScopeIdsForTarget(config: ClankyConfig, target: DiscordScopeTarget): string[] {
	return parseMcpStringList(target === "guilds" ? config.discordAllowedGuildIds : config.discordAllowedChannelIds);
}

function discordScopeRemovalKeys(target: string): string[] | undefined {
	const parsed = parseDiscordScopeTarget(target);
	if (parsed !== undefined) return [discordScopeEnvForTarget(parsed)];
	if (target === "dms" || target === "dm" || target === "allow-dms") return [DISCORD_SCOPE_ENV.dms];
	if (target === "all" || target === "*") return Object.values(DISCORD_SCOPE_ENV);
	return undefined;
}

function parseDiscordScopeIds(args: readonly string[]): string[] | string {
	return parseDiscordScopeIdText(args.join(" "), false);
}

function parseDiscordScopeIdText(raw: string, allowEmpty: boolean): string[] | string {
	const trimmed = raw.trim();
	if (allowEmpty && (trimmed.length === 0 || ["any", "all", "none", "clear", "reset"].includes(trimmed.toLowerCase()))) {
		return [];
	}
	const ids = parseMcpStringList(trimmed)
		.map((id) => id.replace(/^<#?/, "").replace(/>$/, ""))
		.filter((id) => id.length > 0);
	if (ids.length === 0) return "Provide at least one Discord id, or use clear/reset.";
	const invalid = ids.find((id) => !/^\d{5,32}$/.test(id));
	if (invalid !== undefined) return `Invalid Discord id "${invalid}". Use numeric server/channel ids.`;
	return uniqueStrings(ids);
}

function validateDiscordScopeIdText(raw: string, allowEmpty: boolean): string | undefined {
	const parsed = parseDiscordScopeIdText(raw, allowEmpty);
	return typeof parsed === "string" ? parsed : undefined;
}

function parseOnOff(value: string | undefined): boolean | undefined {
	const normalized = value?.trim().toLowerCase();
	if (normalized === "on" || normalized === "yes" || normalized === "true" || normalized === "1" || normalized === "allow") {
		return true;
	}
	if (
		normalized === "off" ||
		normalized === "no" ||
		normalized === "false" ||
		normalized === "0" ||
		normalized === "block"
	) {
		return false;
	}
	return undefined;
}

function uniqueStrings(values: readonly string[]): string[] {
	return [...new Set(values)];
}

async function configureLogin(argument: string, flow: SetupFlow | undefined): Promise<string> {
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

async function selectLoginProvider(flow: SetupFlow): Promise<SubscriptionProvider | undefined> {
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

async function runLogin(provider: SubscriptionProvider, flow: SetupFlow): Promise<string> {
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

async function configureModel(argument: string, flow: SetupFlow | undefined): Promise<string> {
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
type HarnessInteractiveUpdate = {
	updates: Record<string, string>;
	removals?: readonly string[];
	message: string;
};

async function configureHarness(argument: string, flow: SetupFlow | undefined): Promise<string> {
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
	flow: SetupFlow | undefined,
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
			const selected = await flow.readSelect({
				kind: "multi",
				message: `${formatCodingHarnessConfig(config)}\n\nChoose which coding harnesses Clanky may use for worker panes.`,
				options: CODING_HARNESS_OPTIONS,
				initialValues: configuredAllowedHarnesses(config),
				required: true,
			});
			if (selected === undefined) return "/harness allow cancelled.";
			allowed = selectedCodingHarnesses(selected);
		} finally {
			flow.end({ preserveDiagnostics: false });
		}
	}

	const update = buildHarnessAllowlistUpdate(config, allowed);
	if (typeof update === "string") return update;
	await updateEnv(update.updates, update.removals ?? []);
	return await restartBrainMessage(update.message);
}

async function configureHarnessInteractive(flow: SetupFlow, config: ClankyConfig): Promise<string> {
	let update: HarnessInteractiveUpdate | string | undefined;
	flow.begin("Configure coding harness");
	try {
		flow.renderOutput(formatCodingHarnessConfig(config));
		const action = await selectOne(flow, "Choose the coding harness setting to change.", CODING_HARNESS_ACTION_OPTIONS, "status");
		switch (action) {
			case "status":
				update = formatCodingHarnessConfig(config);
				break;
			case "allow": {
				const selectedAllowedValues = await flow.readSelect({
					kind: "multi",
					message: "Toggle which coding harnesses Clanky may use for worker panes.",
					options: CODING_HARNESS_OPTIONS,
					initialValues: configuredAllowedHarnesses(config),
					required: true,
				});
				update = selectedAllowedValues === undefined
					? undefined
					: buildHarnessAllowlistUpdate(config, selectedCodingHarnesses(selectedAllowedValues));
				break;
			}
			case "fallback":
				update = await promptHarnessFallbackUpdate(flow, config);
				break;
			case "custom":
				update = await promptCustomHarnessUpdate(flow, config);
				break;
			default:
				update = undefined;
				break;
		}
	} finally {
		flow.end({ preserveDiagnostics: false });
	}
	if (update === undefined) return "/harness cancelled.";
	if (typeof update === "string") return update;
	await updateEnv(update.updates, update.removals ?? []);
	return await restartBrainMessage(update.message);
}

function buildHarnessAllowlistUpdate(
	config: ClankyConfig,
	allowed: readonly CodingHarnessId[] | undefined,
): HarnessInteractiveUpdate | string {
	if (allowed === undefined || allowed.length === 0) return "Harness allowlist must include at least one harness.";
	const updates: Record<string, string> = { [CLANKY_CODING_HARNESS_ENV.allowed]: allowed.join(",") };
	const configured = parseCodingHarnessId(config.codingHarness);
	const removals = configured !== undefined && !allowed.includes(configured)
		? [CLANKY_CODING_HARNESS_ENV.id, CLANKY_CODING_HARNESS_ENV.runtime]
		: [];
	const autoMessage = removals.length > 0 ? " Cleared the configured fallback; Clanky will pick from the allowed set." : "";
	return {
		updates,
		removals,
		message: `Allowed coding harnesses set to ${allowed.join(", ")}.${autoMessage}`,
	};
}

async function promptHarnessFallbackUpdate(
	flow: SetupFlow,
	config: ClankyConfig,
): Promise<HarnessInteractiveUpdate | string | undefined> {
	const allowed = configuredAllowedHarnesses(config);
	const selectedHarness = parseCodingHarnessId(
		await selectOne(
			flow,
			"Choose the fallback coding harness.",
			CODING_HARNESS_OPTIONS.filter((option) => allowed.includes(option.value as CodingHarnessId)),
			initialAllowedHarnessValue(config, allowed),
		),
	);
	if (selectedHarness === undefined) return undefined;
	if (selectedHarness === "custom") return await promptCustomHarnessUpdate(flow, config);

	const runtime = parseCodingRuntime(
		await selectOne(
			flow,
			"Choose the worker runtime.",
			CODING_RUNTIME_OPTIONS,
			config.codingHarness === selectedHarness ? config.codingHarnessRuntime ?? defaultCodingRuntimeForHarness(selectedHarness) : defaultCodingRuntimeForHarness(selectedHarness),
		),
	);
	if (runtime === undefined) return undefined;

	const launchable = parseLaunchableCodingHarnessId(selectedHarness);
	const tail = ["--runtime", runtime];
	if (launchable !== undefined) {
		const env = codingHarnessEnv(config);
		const launcher = parseCodingHarnessLauncher(
			await selectOne(
				flow,
				`Choose the ${selectedHarness} launcher.`,
				CODING_HARNESS_LAUNCHER_OPTIONS,
				parseCodingHarnessLauncher(env[codingHarnessLauncherEnvKey(launchable)]) ?? "default",
			),
		);
		if (launcher === undefined) return undefined;
		tail.push(launcher);
		if (launcher === "ollama") {
			const model = await flow.readText({
				message: `Set the Ollama model for ${selectedHarness}.`,
				defaultValue: env[codingHarnessModelEnvKey(launchable)] ?? "",
				placeholder: "qwen3-coder:30b",
			});
			if (model === undefined) return undefined;
			if (model.trim().length > 0) tail.push(model.trim());
		}
	}

	const result = buildHarnessUpdate(selectedHarness, tail, config);
	return typeof result === "string" ? result : { updates: result.updates, message: `Coding harness set to ${result.summary}` };
}

async function promptCustomHarnessUpdate(
	flow: SetupFlow,
	config: ClankyConfig,
): Promise<HarnessInteractiveUpdate | string | undefined> {
	if (!configuredAllowedHarnesses(config).includes("custom")) {
		return "Custom coding harness is not allowed. Run /harness allow custom to allow it first.";
	}
	const runtime = parseCodingRuntime(
		await selectOne(flow, "Choose the custom harness runtime.", CODING_RUNTIME_OPTIONS, parseCodingRuntime(config.codingHarnessRuntime) ?? "native"),
	);
	if (runtime === undefined) return undefined;
	const commandText = await flow.readText({
		message: "Set the custom coding harness command.",
		defaultValue: config.codingHarnessCommand ?? "",
		placeholder: "node worker.js",
		validate: validateHarnessCommandText,
	});
	if (commandText === undefined) return undefined;
	let command: string[];
	try {
		command = parseHarnessCommand(commandText) ?? [];
	} catch (error) {
		return `Invalid custom harness command: ${error instanceof Error ? error.message : String(error)}`;
	}
	const result = buildHarnessUpdate("custom", ["--runtime", runtime, ...command], config);
	return typeof result === "string" ? result : { updates: result.updates, message: `Coding harness set to ${result.summary}` };
}

function selectedCodingHarnesses(values: readonly string[]): readonly CodingHarnessId[] {
	return values.map((value) => parseCodingHarnessId(value)).filter((value): value is CodingHarnessId => value !== undefined);
}

function initialAllowedHarnessValue(config: ClankyConfig, allowed: readonly CodingHarnessId[]): CodingHarnessId | undefined {
	const configured = parseCodingHarnessId(config.codingHarness);
	if (configured !== undefined && allowed.includes(configured)) return configured;
	return allowed[0];
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

function formatCodingHarnessConfig(config: ClankyConfig): string {
	const allowed = formatAllowedHarnesses(config);
	try {
		const profile = resolveCodingHarness({ env: codingHarnessEnv(config) });
		return [
			"Current coding harness:",
			`allowed: ${allowed}`,
			`fallback: ${formatCodingHarnessFallback(config, profile)}`,
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

function formatCodingHarnessFallback(config: ClankyConfig, profile: ReturnType<typeof resolveCodingHarness>): string {
	const configured = parseCodingHarnessId(config.codingHarness);
	if (configured === profile.id) return `${profile.id} (${profile.label}, configured)`;
	const suffix = configured === undefined ? "" : `; configured ${configured} is not allowed`;
	return `auto -> ${profile.id} (${profile.label}${suffix})`;
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
		const profile = resolveCodingHarness({ harness: id, env: { ...codingHarnessEnv(config), [CLANKY_CODING_HARNESS_ENV.allowed]: "all" } });
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

async function configureEffort(argument: string, flow: SetupFlow | undefined): Promise<string> {
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

async function configureApprovals(argument: string, flow: SetupFlow | undefined): Promise<string> {
	const mode = splitArgs(argument)[0]?.toLowerCase();
	if (mode === undefined) {
		if (flow === undefined) return formatApprovalsStatus(await readConfig());
		return await configureApprovalsInteractive(flow);
	}
	if (mode === "status" || mode === "show") return formatApprovalsStatus(await readConfig());
	if (mode !== "auto" && mode !== "prompt") {
		return `Unknown approvals mode "${mode}". Use auto, prompt, or status.`;
	}
	return await saveApprovalsMode(mode);
}

async function configureApprovalsInteractive(flow: SetupFlow): Promise<string> {
	flow.begin("Configure approvals");
	try {
		flow.renderOutput(formatApprovalsStatus(await readConfig()));
		const mode = await selectOne(flow, "Choose the approval mode.", APPROVAL_OPTIONS, "status");
		if (mode === undefined) return "/approvals cancelled.";
		if (mode === "status") return formatApprovalsStatus(await readConfig());
		if (mode !== "auto" && mode !== "prompt") return "/approvals cancelled.";
		return await saveApprovalsMode(mode);
	} finally {
		flow.end({ preserveDiagnostics: false });
	}
}

async function saveApprovalsMode(mode: "auto" | "prompt"): Promise<string> {
	await writeEnv({ CLANKY_AUTO_APPROVE: mode === "auto" ? "1" : "0" });
	return await restartBrainMessage(
		mode === "auto"
			? "Auto-approve enabled; Clanky will run all tool calls without asking"
			: "Auto-approve disabled; per-tool approval policy restored",
	);
}

function formatApprovalsStatus(config: ClankyConfig): string {
	const state = isAutoApproveValue(config.autoApprove)
		? "auto (Clanky runs every tool without asking)"
		: "prompt (per-tool approval policy applies)";
	return `Approvals: ${state}. Usage: /approvals [auto|prompt|status]`;
}

async function configureTrace(argument: string, flow: SetupFlow | undefined): Promise<string> {
	const raw = argument.trim();
	const mode = parseTurnTraceMode(raw);
	const normalized = raw.toLowerCase();
	if (raw.length === 0) {
		if (flow === undefined) return formatTraceStatus();
		return await configureTraceInteractive(flow);
	}
	if (normalized === "status" || normalized === "show") return formatTraceStatus();
	if (mode === undefined) return `Unknown trace mode "${argument}". Use /trace off|no-reply|all.`;
	turnTraceMode = mode;
	return formatTraceStatus();
}

async function configureTraceInteractive(flow: SetupFlow): Promise<string> {
	flow.begin("Configure turn trace");
	try {
		flow.renderOutput(formatTraceStatus());
		const selected = await selectOne(flow, "Choose the compact turn trace mode.", TRACE_OPTIONS, turnTraceMode);
		const mode = parseTurnTraceMode(selected);
		if (mode === undefined) return selected === "status" ? formatTraceStatus() : "/trace cancelled.";
		turnTraceMode = mode;
		return formatTraceStatus();
	} finally {
		flow.end({ preserveDiagnostics: false });
	}
}

function formatTraceStatus(): string {
	return `Turn trace: ${turnTraceMode}. Use /trace off|no-reply|all.`;
}

function configureHeader(argument: string): string {
	const mode = argument.trim().toLowerCase();
	if (mode === "status" || mode === "show") return formatHeaderStatus();
	if (mode.length === 0 || mode === "toggle") {
		applyHeaderVisible(!headerVisible);
		return formatHeaderStatus();
	}
	const next = parseBooleanFlag(mode);
	if (next === undefined) return `Unknown header mode "${argument}". Use /header on|off|toggle|status.`;
	applyHeaderVisible(next);
	return formatHeaderStatus();
}

function applyHeaderVisible(visible: boolean): void {
	headerVisible = visible;
	banner.setVisible(visible);
	tui.requestRender();
}

function formatHeaderStatus(): string {
	return `Header: ${headerVisible ? "on" : "off"}. Use /header on|off|toggle|status.`;
}

async function configureImageModel(argument: string, flow: SetupFlow | undefined): Promise<string> {
	const args = splitArgs(argument);
	const first = args[0]?.toLowerCase();
	const config = await readConfig();
	if (first === "status" || first === "show") return formatImageModelStatus(config);
	if (first === "unset" || first === "clear" || first === "default" || first === "none" || first === "off") {
		await removeEnv(["CLANKY_OPENAI_IMAGE_MODEL"]);
		return await restartBrainMessage(`OpenAI image model cleared; using ${DEFAULT_OPENAI_IMAGE_MODEL}`);
	}
	if (argument.trim().length > 0) return await saveOpenAiImageModel(argument);
	if (flow === undefined) return `${formatImageModelStatus(config)}\n\n${imageModelUsage()}`;
	return await configureImageModelInteractive(flow, config);
}

async function configureImageModelInteractive(flow: SetupFlow, config: ClankyConfig): Promise<string> {
	let update: ImageModelUpdate | undefined;
	flow.begin("Configure image model");
	try {
		flow.renderOutput(formatImageModelStatus(config));
		const selected = await selectOne(
			flow,
			"Choose the OpenAI image generation model.",
			imageModelOptions(config),
			config.imageModel ?? DEFAULT_OPENAI_IMAGE_MODEL,
		);
		if (selected === undefined) return "/image-model cancelled.";
		if (selected === CLEAR_IMAGE_MODEL_OPTION) {
			update = {
				removals: ["CLANKY_OPENAI_IMAGE_MODEL"],
				message: `OpenAI image model cleared; using ${DEFAULT_OPENAI_IMAGE_MODEL}`,
			};
		} else {
			const rawModel = selected === CUSTOM_IMAGE_MODEL_OPTION
				? await flow.readText({
					message: "Set the OpenAI image generation model.",
					defaultValue: config.imageModel ?? DEFAULT_OPENAI_IMAGE_MODEL,
					placeholder: DEFAULT_OPENAI_IMAGE_MODEL,
					validate: requiredImageModelText,
				})
				: selected;
			if (rawModel === undefined) return "/image-model cancelled.";
			const model = rawModel.trim();
			update = {
				updates: { CLANKY_OPENAI_IMAGE_MODEL: model },
				message: `OpenAI image model set to ${model}`,
			};
		}
	} finally {
		flow.end({ preserveDiagnostics: false });
	}
	if (update.removals !== undefined) await removeEnv(update.removals);
	if (update.updates !== undefined) await writeEnv(update.updates);
	return await restartBrainMessage(update.message);
}

async function saveOpenAiImageModel(rawModel: string): Promise<string> {
	const model = rawModel.trim();
	if (model.length === 0) return imageModelUsage();
	await writeEnv({ CLANKY_OPENAI_IMAGE_MODEL: model });
	return await restartBrainMessage(`OpenAI image model set to ${model}`);
}

function imageModelOptions(config: ClankyConfig): readonly MenuOption[] {
	const current = config.imageModel?.trim();
	const options: MenuOption[] = [];
	if (current !== undefined && current.length > 0 && current !== DEFAULT_OPENAI_IMAGE_MODEL) {
		options.push({ value: current, label: current, hint: "current" });
	}
	options.push(
		{
			value: DEFAULT_OPENAI_IMAGE_MODEL,
			label: DEFAULT_OPENAI_IMAGE_MODEL,
			hint: current === undefined || current.length === 0 || current === DEFAULT_OPENAI_IMAGE_MODEL ? "current default" : "built-in default",
		},
		{ value: CUSTOM_IMAGE_MODEL_OPTION, label: "custom model id", hint: "type another OpenAI Images API model" },
		{ value: CLEAR_IMAGE_MODEL_OPTION, label: "clear override", hint: `use built-in ${DEFAULT_OPENAI_IMAGE_MODEL}` },
	);
	return options;
}

function formatImageModelStatus(config: ClankyConfig): string {
	const configured = config.imageModel?.trim();
	const source = configured === undefined || configured.length === 0 ? "built-in default" : ".env.local";
	return `OpenAI image model: ${configured && configured.length > 0 ? configured : DEFAULT_OPENAI_IMAGE_MODEL} (${source})`;
}

function imageModelUsage(): string {
	return [
		"Usage:",
		"/image-model",
		"/image-model status",
		`/image-model ${DEFAULT_OPENAI_IMAGE_MODEL}`,
		"/image-model <model-id>",
		"/image-model unset",
	].join("\n");
}

async function configureVisionModel(argument: string, flow: SetupFlow | undefined): Promise<string> {
	const args = splitArgs(argument);
	const first = args[0]?.toLowerCase();
	const config = await readConfig();
	if (first === "status" || first === "show") return formatVisionModelStatus(config);
	if (first === "unset" || first === "clear" || first === "default" || first === "none" || first === "off") {
		await removeEnv(["CLANKY_LOCAL_VISION_MODEL"]);
		return await restartBrainMessage("Local vision model override cleared");
	}
	if (first === "local") return await saveLocalVisionModel(args.slice(1).join(" "));
	if (first === "openai") return await saveOpenAiVisionModel(args.slice(1).join(" "));
	if (argument.trim().length > 0) return await saveLocalVisionModel(argument);
	if (flow === undefined) return `${formatVisionModelStatus(config)}\n\n${visionModelUsage()}`;
	return await configureVisionModelInteractive(flow, config);
}

async function configureVisionModelInteractive(flow: SetupFlow, config: ClankyConfig): Promise<string> {
	let update: { updates?: Record<string, string>; removals?: string[]; message: string } | undefined;
	flow.begin("Configure vision model");
	try {
		flow.renderOutput(formatVisionModelStatus(config));
		const action = await selectOne(
			flow,
			"Choose the vision setting to change.",
			[
				{ value: "local", label: "local vision model", hint: config.localVisionModel ?? "active local model" },
				{ value: "openai", label: "OpenAI fallback model", hint: config.openAiVisionModel ?? "gpt-5.4-mini" },
				{ value: "clear-local", label: "clear local override", hint: "use active local model when it supports vision" },
			],
			"local",
		);
		if (action === undefined) return "/vision-model cancelled.";
		if (action === "clear-local") {
			update = { removals: ["CLANKY_LOCAL_VISION_MODEL"], message: "Local vision model override cleared" };
		} else {
			const current = action === "openai" ? config.openAiVisionModel : config.localVisionModel;
			const value = await flow.readText({
				message: action === "openai" ? "Set the OpenAI fallback vision model." : "Set the local vision model for media_inspect.",
				defaultValue: current ?? "",
				placeholder: action === "openai" ? "gpt-5.4-mini" : "qwen3-vl:32b",
				validate: requiredVisionModelText,
			});
			if (value === undefined) return "/vision-model cancelled.";
			const model = value.trim();
			update =
				action === "openai"
					? { updates: { CLANKY_OPENAI_VISION_MODEL: model }, message: `OpenAI fallback vision model set to ${model}` }
					: { updates: { CLANKY_LOCAL_VISION_MODEL: model }, message: `Local vision model set to ${model}` };
		}
	} finally {
		flow.end({ preserveDiagnostics: false });
	}
	if (update.removals !== undefined) await removeEnv(update.removals);
	if (update.updates !== undefined) await writeEnv(update.updates);
	return await restartBrainMessage(update.message);
}

async function saveLocalVisionModel(rawModel: string): Promise<string> {
	const model = rawModel.trim();
	if (model.length === 0) return "Usage: /vision-model <model-id> or /vision-model unset";
	await writeEnv({ CLANKY_LOCAL_VISION_MODEL: model });
	return await restartBrainMessage(`Local vision model set to ${model}`);
}

async function saveOpenAiVisionModel(rawModel: string): Promise<string> {
	const model = rawModel.trim();
	if (model.length === 0) return "Usage: /vision-model openai <model-id>";
	await writeEnv({ CLANKY_OPENAI_VISION_MODEL: model });
	return await restartBrainMessage(`OpenAI fallback vision model set to ${model}`);
}

function formatVisionModelStatus(config: ClankyConfig): string {
	return [
		`local vision model: ${config.localVisionModel ?? "(active local model)"}`,
		`OpenAI fallback vision model: ${config.openAiVisionModel ?? "gpt-5.4-mini"}`,
	].join("\n");
}

function visionModelUsage(): string {
	return [
		"Usage:",
		"/vision-model",
		"/vision-model status",
		"/vision-model <local-model-id>",
		"/vision-model local <local-model-id>",
		"/vision-model openai <model-id>",
		"/vision-model unset",
	].join("\n");
}

async function configurePet(argument: string, flow: SetupFlow | undefined): Promise<string> {
	const mode = splitArgs(argument)[0]?.toLowerCase();
	if (mode === undefined) {
		if (flow === undefined) return formatPetStatus(await readConfig());
		return await configurePetInteractive(flow);
	}
	if (mode === "status" || mode === "show") return formatPetStatus(await readConfig());
	if (mode === "on" || mode === "off") return await savePetMode(mode);
	return `Unknown pet mode "${mode}". Use on, off, or status.`;
}

async function configurePetInteractive(flow: SetupFlow): Promise<string> {
	flow.begin("Configure desktop pet");
	try {
		const config = await readConfig();
		flow.renderOutput(formatPetStatus(config));
		const selected = await selectOne(flow, "Choose the desktop pet state.", PET_OPTIONS, isPetEnabledValue(config.pet) ? "on" : "off");
		if (selected === undefined) return "/pet cancelled.";
		if (selected === "status") return formatPetStatus(await readConfig());
		if (selected !== "on" && selected !== "off") return "/pet cancelled.";
		return await savePetMode(selected);
	} finally {
		flow.end({ preserveDiagnostics: false });
	}
}

async function savePetMode(mode: "on" | "off"): Promise<string> {
	if (mode === "on") {
		await writeEnv({ CLANKY_PET: "1" });
		return await restartBrainMessage("Desktop pet enabled; Clanky will mirror activity to the petdex sprite");
	}
	await writeEnv({ CLANKY_PET: "0" });
	return await restartBrainMessage("Desktop pet disabled");
}

function formatPetStatus(config: ClankyConfig): string {
	const state = isPetEnabledValue(config.pet) ? "on" : "off";
	return `Pet: ${state} (needs the petdex desktop app running). Usage: /pet [on|off|status]`;
}

async function configureVoice(argument: string, flow: SetupFlow | undefined): Promise<string> {
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
	flow: SetupFlow,
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
	flow: SetupFlow,
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

async function configureIntegrations(argument: string, flow: SetupFlow | undefined): Promise<string> {
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
	flow: SetupFlow | undefined,
	renderer: CommandRenderer,
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
	flow: SetupFlow,
	renderer: CommandRenderer,
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
	flow: SetupFlow,
	renderer: CommandRenderer,
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
	flow: SetupFlow,
	renderer: CommandRenderer,
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
	flow: SetupFlow,
	renderer: CommandRenderer,
): Promise<string> {
	const info = await fetchInfo();
	if (info === undefined) return `${MCP_CONNECTION_INFO_UNAVAILABLE}\n\nCannot authorize "${connectionName}" until the eve dev server info endpoint recovers.`;
	const connection = findMcpConnectionInInfo(info, connectionName);
	if (connection === undefined) return `Unknown curated MCP connection "${connectionName}".\n\n${await mcpConnectionsText()}`;
	return await runMcpConnectionAuth(connection, flow, renderer);
}

async function runMcpConnectionAuth(
	connection: AgentInfoConnectionEntry,
	flow: SetupFlow,
	renderer: CommandRenderer,
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
		return `${connection.connectionName} auth probe finished, but Clanky did not call connection_search. Try asking Clanky to use ${connection.connectionName}.`;
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
	flow: SetupFlow,
	renderer: CommandRenderer,
	signal: AbortSignal,
	updatePendingAuth: (countDelta: number) => void,
): Promise<McpAuthProbeResult> {
	flow.renderLine(`Checking ${connection.connectionName} with connection_search. OAuth prompts will open in your browser when needed.`, "info");
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
	flow: SetupFlow,
	renderer: CommandRenderer,
	updatePendingAuth: (countDelta: number) => void,
	result: McpAuthProbeResult,
): void {
	switch (event.type) {
		case "actions.requested":
			for (const action of event.data.actions) {
				if (action.kind === "tool-call" && action.toolName === "connection_search") {
					result.sawConnectionSearch = true;
					flow.setStatus(`Discovering ${connection.connectionName} connection tools...`);
				}
			}
			break;
		case "action.result": {
			const action = event.data.result;
			if (action.kind !== "tool-result" || action.toolName !== "connection_search") break;
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
			renderFlowLines(flow, lines, "info");
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

function renderFlowLines(
	flow: SetupFlow,
	lines: readonly string[],
	tone: Parameters<SetupFlow["renderLine"]>[1],
): void {
	for (const line of lines) {
		for (const segment of line.split(/\r?\n/)) {
			if (segment.trim().length > 0) flow.renderLine(segment, tone);
		}
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
		`Use connection_search to discover tools for only the curated MCP connection named "${connectionName}".`,
		"Do not call any connection tool other than connection_search. Do not create, update, delete, post, or mutate anything.",
		"If authorization is required, wait for the authorization flow to complete. Then reply with one short status sentence.",
	].join("\n");
}

async function promptAndSaveMcpServer(flow: SetupFlow): Promise<string> {
	const configured = await promptMcpServerConfig(flow);
	if (configured === undefined) return "/mcp add cancelled.";
	const result = await upsertMcpServer(configured.name, configured.config);
	return `Dynamic MCP server "${configured.name}" saved to ${result.path}. Run /mcp list ${configured.name} to verify tools.`;
}

async function promptMcpServerConfig(flow: SetupFlow): Promise<{ name: string; config: McpServerConfig } | undefined> {
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

async function promptAndRemoveMcpServer(flow: SetupFlow): Promise<string> {
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

async function promptAndSetMcpServerEnabled(flow: SetupFlow, enabled: boolean): Promise<string> {
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
	flow: SetupFlow,
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

async function selectMcpConnectionName(flow: SetupFlow, initialValue: string | undefined): Promise<string | undefined> {
	const info = await fetchInfo();
	if (info === undefined) {
		flow.renderLine(MCP_CONNECTION_INFO_UNAVAILABLE, "warning");
		return undefined;
	}
	const connections = mcpConnections(info);
	if (connections.length === 0) {
		flow.renderLine("No curated MCP connections are installed in this eve server.", "warning");
		return undefined;
	}
	return await selectOne(
		flow,
		"Choose the curated MCP connection to verify or authorize.",
		connections.map((connection) => ({
			value: connection.connectionName,
			label: connection.connectionName,
			hint: mcpConnectionAuthHint(connection),
			description: connection.description,
		})),
		initialValue,
	);
}

async function findMcpConnection(name: string): Promise<AgentInfoConnectionEntry | undefined> {
	const info = await fetchInfo();
	return info === undefined ? undefined : findMcpConnectionInInfo(info, name);
}

function findMcpConnectionInInfo(info: AgentInfoResult, name: string): AgentInfoConnectionEntry | undefined {
	const normalized = normalizeCommandToken(name);
	return mcpConnections(info).find((connection) => normalizeCommandToken(connection.connectionName) === normalized);
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
	if (info === undefined) return [MCP_CONNECTION_INFO_UNAVAILABLE];
	const connections = mcpConnections(info);
	if (connections.length === 0) return ["(none)"];
	return connections.map((connection) => {
		const auth = mcpConnectionAuthHint(connection);
		const approval = mcpConnectionHasApproval(connection) ? "approval" : "no approval";
		return `- ${connection.connectionName}: ${connection.protocol}, ${auth}, ${approval} - ${connection.description}`;
	});
}

function mcpConnectionAuthHint(connection: AgentInfoConnectionEntry): string {
	return mcpConnectionHasAuthorization(connection) ? "oauth" : "no oauth";
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
	const curated = info === undefined ? undefined : mcpConnections(info).map((connection) => connection.connectionName);
	const dynamic = Object.keys(store.servers).sort((a, b) => a.localeCompare(b));
	const curatedSummary = curated === undefined ? "unavailable" : curated.length === 0 ? "none" : curated.join(",");
	return `curated=${curatedSummary} dynamic=${dynamic.length === 0 ? "none" : dynamic.join(",")}`;
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

function requiredDiscordTokenText(value: string): string | undefined {
	return value.trim().length === 0 ? "Paste a Discord credential." : undefined;
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

async function configureBrowserBridge(argument: string, flow: SetupFlow | undefined): Promise<string> {
	const command = splitArgs(argument)[0] ?? "status";
	if (argument.trim().length === 0 && flow !== undefined) return await configureBrowserBridgeInteractive(flow);
	if (command === "status") return formatBrowserBridgeStatus(await browserBridgeStatus());
	if (command !== "install") return "Usage: /browser [status|install]";
	return await installBrowserBridgeMessage();
}

async function configureBrowserBridgeInteractive(flow: SetupFlow): Promise<string> {
	flow.begin("Configure browser bridge");
	try {
		flow.renderOutput(formatBrowserBridgeStatus(await browserBridgeStatus()));
		const selected = await selectOne(flow, "Choose the browser bridge action.", BROWSER_BRIDGE_OPTIONS, "status");
		if (selected === undefined) return "/browser cancelled.";
		if (selected === "status") return formatBrowserBridgeStatus(await browserBridgeStatus());
		if (selected === "install") return await installBrowserBridgeMessage();
		return "/browser cancelled.";
	} finally {
		flow.end({ preserveDiagnostics: false });
	}
}

async function installBrowserBridgeMessage(): Promise<string> {
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
		`eve brain: ${formatBrainHealthSummary(brainHealth)}`,
		`provider: ${formatProviderSummary(config)}`,
		`auth: claude=${formatCredStatus(claudeAuth)}; codex=${formatCredStatus(codexAuth)}`,
		`approvals: ${isAutoApproveValue(config.autoApprove) ? "auto (no prompts)" : "prompt"}`,
		`coding harness: ${formatCodingHarnessSummary(config)}`,
		`image model: ${config.imageModel ?? DEFAULT_OPENAI_IMAGE_MODEL}`,
		`vision model: local=${config.localVisionModel ?? "(active local model)"}; openai fallback=${config.openAiVisionModel ?? "gpt-5.4-mini"}`,
		...formatVoiceStatusLines(config),
		`integrations: ${formatIntegrationSummary(bindings, connections)}`,
		`mcp: ${formatMcpStatusSummary(info, mcpStore)}`,
		`browser bridge: ${formatBrowserBridgeSummary(browser)}`,
		`discord scope: ${formatDiscordScopeSummary(config)}`,
		`discord gateway: ${formatJson(gateway)}`,
	];
	return lines.join("\n");
}

function formatBrainHealthSummary(health: BrainHealthState): string {
	switch (health.state) {
		case "unknown":
			return `unknown (${brainHost})`;
		case "restarting": {
			const detail = health.detail === undefined ? "" : `: ${health.detail}`;
			return `restarting (${brainHost})${detail}`;
		}
		case "healthy":
			return `healthy (${brainHost})`;
		case "unhealthy": {
			const statusText = health.statusText.length === 0 ? "" : ` ${health.statusText}`;
			const detail = health.detail === undefined ? "" : `: ${health.detail}`;
			return `unhealthy ${health.status}${statusText} (${brainHost})${detail}`;
		}
		case "down":
			return `down (${brainHost}): ${health.detail}`;
	}
}

function formatDiscordScopeSummary(config: ClankyConfig): string {
	return [
		`guilds=${formatDiscordScopeList(config.discordAllowedGuildIds, "any")}`,
		`channels=${formatDiscordScopeList(config.discordAllowedChannelIds, "any")}`,
		`dms=${configBooleanDefaultTrue(config.discordAllowDms) ? "allowed" : "blocked"}`,
	].join("; ");
}

function formatDiscordScopeList(raw: string | undefined, fallback: string): string {
	const ids = parseMcpStringList(raw);
	return ids.length === 0 ? fallback : ids.join(",");
}

function configBooleanDefaultTrue(raw: string | undefined): boolean {
	return parseToggle(raw) ?? true;
}

function parseToggle(value: string | undefined): boolean | undefined {
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

async function selectProvider(
	flow: SetupFlow,
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
	flow: SetupFlow,
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
	flow: SetupFlow,
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
	flow: SetupFlow,
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
	flow: SetupFlow,
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

function validateHarnessCommandText(value: string): string | undefined {
	try {
		const command = parseHarnessCommand(value);
		return command === undefined || command.length === 0 ? "Enter a command." : undefined;
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
}

function requiredImageModelText(value: string): string | undefined {
	return value.trim().length === 0 ? "Enter a model id." : undefined;
}

function requiredVisionModelText(value: string): string | undefined {
	return value.trim().length === 0 ? "Enter a model id." : undefined;
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
	const localContextTokens = get(LOCAL_CONTEXT_TOKENS_ENV);
	const localVisionModel = get("CLANKY_LOCAL_VISION_MODEL");
		const openAiVisionModel = get("CLANKY_OPENAI_VISION_MODEL");
		const autoApprove = get("CLANKY_AUTO_APPROVE");
			const pet = get("CLANKY_PET");
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
	const discordAllowedGuildIds = get(DISCORD_SCOPE_ENV.guilds);
	const discordAllowedChannelIds = get(DISCORD_SCOPE_ENV.channels);
	const discordAllowDms = get(DISCORD_SCOPE_ENV.dms);
	if (codexModel !== undefined) config.codexModel = codexModel;
	if (claudeModel !== undefined) config.claudeModel = claudeModel;
	if (codexEffort !== undefined) config.codexEffort = codexEffort;
	if (localModel !== undefined) config.localModel = localModel;
	if (localBaseUrl !== undefined) config.localBaseUrl = localBaseUrl;
	if (localEffort !== undefined) config.localEffort = localEffort;
	if (localContextTokens !== undefined) config.localContextTokens = localContextTokens;
	if (localVisionModel !== undefined) config.localVisionModel = localVisionModel;
		if (openAiVisionModel !== undefined) config.openAiVisionModel = openAiVisionModel;
		if (autoApprove !== undefined) config.autoApprove = autoApprove;
			if (pet !== undefined) config.pet = pet;
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
	if (discordAllowedGuildIds !== undefined) config.discordAllowedGuildIds = discordAllowedGuildIds;
	if (discordAllowedChannelIds !== undefined) config.discordAllowedChannelIds = discordAllowedChannelIds;
	if (discordAllowDms !== undefined) config.discordAllowDms = discordAllowDms;
	return config;
}

async function writeEnv(updates: Record<string, string>): Promise<void> {
	await updateEnv(updates, []);
}

async function removeEnv(keys: string[]): Promise<void> {
	await updateEnv({}, keys);
}

async function updateEnv(updates: Record<string, string>, removals: readonly string[]): Promise<void> {
	const existing = await readFile(ENV_PATH, "utf8").catch(() => "");
	const withoutRemovals = removals.length === 0 ? existing : applyEnvRemovals(existing, removals);
	const next = Object.keys(updates).length === 0 ? withoutRemovals : applyEnvUpserts(withoutRemovals, updates);
	await writeFile(ENV_PATH, next, "utf8");
}

async function restartBrainMessage(prefix: string): Promise<string> {
	await refreshEffortStatusSuffix();
	if (!ownsServer) {
		return appendRestartSentence(prefix, "Saved .env.local; attached to an external eve server, so restart it to apply.");
	}

	brainRestartInProgress = true;
	brainHealthGeneration += 1;
	stopBrainHealthMonitor();
	setBrainHealth({ state: "restarting", checkedAt: Date.now(), detail: "applying configuration" });
	refreshStatus("restarting");

	try {
		await stopServer();
		await startServer();
		await waitForHealth();
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		brainRestartInProgress = false;
		brainHealthGeneration += 1;
		setBrainHealth({ state: "down", checkedAt: Date.now(), detail });
		startBrainHealthMonitor();
		refreshStatus("ready");
		return appendRestartSentence(
			prefix,
			`Saved .env.local, but restarting Clanky failed: ${detail}`,
		);
	}

	brainRestartInProgress = false;
	brainHealthGeneration += 1;
	const info = await fetchInfo();
	if (info !== undefined) updateLatestInfo(info);
	forwardServerOutput = true;
	startBrainHealthMonitor();
	refreshStatus("ready");
	return appendRestartSentence(prefix, "Restarted Clanky.");
}

function appendRestartSentence(prefix: string, sentence: string): string {
	const trimmed = prefix.trim();
	return `${trimmed}${/[.!?]$/u.test(trimmed) ? " " : ". "}${sentence}`;
}

type FetchInfoOptions = {
	readonly healthGeneration?: number;
	readonly reportHealth?: boolean;
};

async function fetchInfo(options: FetchInfoOptions = {}): Promise<AgentInfoResult | undefined> {
	const reportHealth = options.reportHealth ?? true;
	try {
		const response = await fetch(`${brainHost}/eve/v1/info`);
		if (!response.ok) {
			if (shouldReportFetchInfoHealth(options, reportHealth)) {
				setBrainHealth({
					state: "unhealthy",
					checkedAt: Date.now(),
					status: response.status,
					statusText: response.statusText,
					detail: await responseDetail(response),
				});
			}
			return undefined;
		}
		const info = (await response.json()) as AgentInfoResult;
		if (shouldReportFetchInfoHealth(options, reportHealth)) setBrainHealth({ state: "healthy", checkedAt: Date.now() });
		return info;
	} catch (error) {
		if (shouldReportFetchInfoHealth(options, reportHealth)) {
			setBrainHealth({
				state: "down",
				checkedAt: Date.now(),
				detail: error instanceof Error ? error.message : String(error),
			});
		}
		return undefined;
	}
}

function shouldReportFetchInfoHealth(options: FetchInfoOptions, reportHealth: boolean): boolean {
	if (!reportHealth || brainRestartInProgress) return false;
	return options.healthGeneration === undefined || options.healthGeneration === brainHealthGeneration;
}

async function fetchBrainHealth(): Promise<BrainHealthState> {
	try {
		const response = await fetch(`${brainHost}/eve/v1/health`);
		if (response.ok) return { state: "healthy", checkedAt: Date.now() };
		return {
			state: "unhealthy",
			checkedAt: Date.now(),
			status: response.status,
			statusText: response.statusText,
			detail: await responseDetail(response),
		};
	} catch (error) {
		return {
			state: "down",
			checkedAt: Date.now(),
			detail: error instanceof Error ? error.message : String(error),
		};
	}
}

async function responseDetail(response: Response): Promise<string | undefined> {
	try {
		const text = (await response.text()).trim();
		return text.length === 0 ? undefined : truncate(text.replace(/\s+/gu, " "), 240);
	} catch {
		return undefined;
	}
}

function setBrainHealth(next: BrainHealthState): void {
	if (brainRestartInProgress && next.state !== "restarting") return;
	brainHealth = next;
	refreshBrainHealthView();
}

async function fetchDiscordGatewayHealth(): Promise<unknown> {
	try {
		const response = await fetch(`${brainHost}/discord-gateway/health`);
		return await response.json();
	} catch {
		return { running: false };
	}
}

async function probe(host = brainHost): Promise<"healthy" | "reachable" | "down"> {
	try {
		return (await fetch(`${host}/eve/v1/info`)).ok ? "healthy" : "reachable";
	} catch {
		return "down";
	}
}

async function discoverDevServerHost(): Promise<DiscoveredHost | undefined> {
	const record = await readDevServerRecord();
	if (record === undefined || !isPidAlive(record.pid)) return undefined;
	const host = normalizeHost(record.url);
	if (host === undefined) return undefined;
	return {
		host,
		source: `.eve/dev-server.json pid ${record.pid}${record.updatedAt === undefined ? "" : ` updated ${record.updatedAt}`}`,
	};
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

function isPidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return typeof error === "object" && error !== null && "code" in error && String(error.code) === "EPERM";
	}
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

async function startServer(): Promise<void> {
	forwardServerOutput = false;
	ownedServerStartupOutput = "";
	ownedServerStartError = undefined;
	brainHost = HOST;
	const env = await buildOwnedServerEnv();
	const child = spawn(join(REPO, "node_modules", ".bin", "eve"), ["dev", "--no-ui", "--port", String(PORT)], {
		cwd: REPO,
		env,
		stdio: ["ignore", "pipe", "pipe"],
	});
	server = child;
	child.once("error", (error: Error) => {
		ownedServerStartError = error;
		appendOwnedServerStartupOutput(`failed to start eve: ${error.message}\n`);
		if (server === child) server = null;
	});
	child.once("exit", () => {
		if (server === child) server = null;
	});
	child.stdout?.on("data", (chunk: Buffer) => forwardOwnedServerOutput("stdout", chunk));
	child.stderr?.on("data", (chunk: Buffer) => forwardOwnedServerOutput("stderr", chunk));
}

async function buildOwnedServerEnv(): Promise<NodeJS.ProcessEnv> {
	const env = withClankyFaceHerdrEnv(buildEveDevServerEnv(process.env, HOST, PORT));
	const config = await readConfig();
	if (config.provider !== "local") return env;
	if (parseLocalContextWindowTokens(env[LOCAL_CONTEXT_TOKENS_ENV]) !== undefined) return env;
	if (parseLocalContextWindowTokens(config.localContextTokens) !== undefined) return env;

	const contextTokens = await resolveOllamaContextWindowTokens({
		baseURL: config.localBaseUrl ?? DEFAULT_LOCAL_BASE_URL,
		modelId: config.localModel ?? "qwen3-coder-next",
	});
	if (contextTokens === undefined) return env;
	return { ...env, [LOCAL_CONTEXT_TOKENS_ENV]: String(contextTokens) };
}

function withClankyFaceHerdrEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const next = { ...env };
	copyEnvIfPresent(next, CLANKY_FACE_HERDR_PANE_ID_ENV, process.env.HERDR_PANE_ID);
	copyEnvIfPresent(next, CLANKY_FACE_HERDR_TAB_ID_ENV, process.env.HERDR_TAB_ID);
	copyEnvIfPresent(next, CLANKY_FACE_HERDR_WORKSPACE_ID_ENV, process.env.HERDR_WORKSPACE_ID);
	return next;
}

function copyEnvIfPresent(env: NodeJS.ProcessEnv, key: string, value: string | undefined): void {
	if (value !== undefined && value.length > 0) env[key] = value;
}

function forwardOwnedServerOutput(stream: "stdout" | "stderr", chunk: Buffer): void {
	const text = chunk.toString("utf8");
	if (isSuppressedOwnedServerOutput(text)) return;
	appendOwnedServerStartupOutput(text);
	if (!forwardServerOutput) return;
	insertMarkdown(`**eve ${stream}**\n\n\`\`\`\n${truncate(text.trim(), 4_000)}\n\`\`\``);
}

function appendOwnedServerStartupOutput(text: string): void {
	ownedServerStartupOutput += text;
	if (ownedServerStartupOutput.length > OWNED_SERVER_STARTUP_OUTPUT_LIMIT) {
		ownedServerStartupOutput = ownedServerStartupOutput.slice(-OWNED_SERVER_STARTUP_OUTPUT_LIMIT);
	}
}

function isSuppressedOwnedServerOutput(text: string): boolean {
	return (
		text.includes("Vercel beta terms") ||
		text.includes("Public preview: https://vercel.com/docs/release-phases/public-beta-agreement")
	);
}

async function ensureServer(): Promise<boolean> {
	const discovered = await discoverDevServerHost();
	if (discovered !== undefined) {
		brainHost = discovered.host;
		const state = await probe(brainHost);
		if (state === "healthy") return false;
		if (state === "reachable") {
			process.stdout.write(`  \x1b[2mdev server ${brainHost} is reachable but not ready; attaching anyway.\x1b[22m\n`);
			return false;
		}
	}

	brainHost = HOST;
	const initial = await probe(HOST);
	if (initial === "healthy") return false;
	if (initial === "reachable") {
		process.stdout.write(`  \x1b[2ma server is on ${HOST} but not ready yet; waiting...\x1b[22m\n`);
		const deadline = Date.now() + 20_000;
		while (Date.now() < deadline) {
			await new Promise((resolve) => setTimeout(resolve, 800));
			if ((await probe(HOST)) === "healthy") return false;
		}
		process.stdout.write(`  \x1b[33m${HOST} is up but unhealthy. Restart the eve server that owns it; attaching anyway.\x1b[39m\n`);
		return false;
	}

	await startServer();
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

		const targetUrl = new URL(`${sourceUrl.pathname}${sourceUrl.search}`, brainHost);
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

async function waitForHealth(timeoutMs = HEALTH_TIMEOUT_MS): Promise<void> {
	const child = server;
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		if (ownedServerStartError !== undefined) {
			throw new Error(`Eve server process failed to start: ${ownedServerStartError.message}`);
		}
		if (child !== null && hasChildExited(child)) throw new Error(ownedServerExitMessage(child));
		try {
			const response = await fetch(`${brainHost}/eve/v1/info`);
			if (response.ok) return;
		} catch {
			// Server is still starting.
		}
		if (Date.now() > deadline) throw new Error(`Clanky server did not become healthy on ${brainHost}`);
		await new Promise((resolve) => setTimeout(resolve, 500));
	}
}

async function stopServer(): Promise<void> {
	const child = server;
	server = null;
	forwardServerOutput = false;
	if (child === null || hasChildExited(child)) return;
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
	return await new Promise<boolean>((resolve) => {
		let settled = false;
		const finish = (exited: boolean): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			child.off("exit", onExit);
			child.off("error", onError);
			resolve(exited);
		};
		const onExit = (): void => finish(true);
		const onError = (): void => finish(true);
		const timeout = setTimeout(() => finish(false), timeoutMs);
		child.once("exit", onExit);
		child.once("error", onError);
		if (hasChildExited(child)) finish(true);
	});
}

function ownedServerExitMessage(child: ChildProcess): string {
	const status =
		child.exitCode !== null
			? `exit code ${child.exitCode}`
			: child.signalCode !== null
				? `signal ${child.signalCode}`
				: "unknown status";
	const output = ownedServerStartupOutput.trim();
	return output.length === 0
		? `Eve server exited before becoming healthy (${status})`
		: `Eve server exited before becoming healthy (${status}). Recent server output:\n${output}`;
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

function formatError(error: unknown): string {
	return error instanceof Error ? error.stack ?? error.message : String(error);
}

function truncate(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	return `${text.slice(0, maxChars)}\n... truncated ${text.length - maxChars} chars`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
