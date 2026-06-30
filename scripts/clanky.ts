/**
 * Clanky's custom face (SPEC.md §4.2).
 *
 * The face owns Clanky-specific slash commands and server lifecycle, then
 * renders the public eve/client event stream with pi-tui.
 *
 * Run: pnpm face   (CLANKY_EVE_PORT to change the port, default 2000)
 */
import { type ChildProcess, execFile, execFileSync, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { access, readFile, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http";
import { join, resolve } from "node:path";
import { parseEnv, promisify } from "node:util";
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
	truncateToWidth,
	type Component,
	type OverlayHandle,
	type OverlayOptions,
	visibleWidth,
	wrapTextWithAnsi,
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
import { apnsConfigFromEnv, sendApns } from "../agent/lib/apns.ts";
import { browserBridgeStatus } from "../agent/lib/browser-bridge.ts";
import { buildEveDevServerEnv } from "../agent/lib/eve-dev-env.ts";
import { startFacePresence, stopFacePresence, type FaceCommandRequest } from "../agent/lib/face-presence.ts";
import type { ClankyMenuClientMessage, ClankyMenuServerEvent } from "../agent/lib/clanky-menu-protocol.ts";
import { buildPairingLink, type PairingLink, renderPairingQr } from "../agent/lib/pairing.ts";
import { listClankySkills, type ClankySkillInventoryEntry } from "../agent/lib/skill-inventory.ts";
import { renderClankySkillsPanel } from "../agent/lib/clanky-skills-panel.ts";
import {
	appendPromptHistoryEntry,
	clankyPromptHistoryPath,
	readPromptHistoryFile,
} from "../agent/lib/tui-prompt-history.ts";
import { InputRequestQueue } from "../agent/lib/tui-input-request-queue.ts";
import {
	readTuiSessionStore,
	rememberTuiSession,
	sessionStateId,
	type TuiSessionEntry,
} from "../agent/lib/tui-session-store.ts";
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
import { readMcpOAuthStates, type McpOAuthState } from "../agent/lib/mcp-oauth.ts";
import { inspectConnectionSearchOutput } from "../agent/lib/mcp-auth-probe.ts";
import { isAutoApproveValue } from "../agent/lib/approvals.ts";
import {
	AGENT_MD_FILENAMES,
	CLANKY_AGENT_MD_ENV,
	CLANKY_AGENT_MD_ROOT_ENV,
	collectAgentMdFiles,
	parseAgentMdToggle,
} from "../agent/lib/agent-md.ts";
import { isPetEnabledValue } from "../agent/lib/pet.ts";
import { resolveClankyDataPath } from "../agent/lib/paths.ts";
import { listPushDevices, type PushDevice } from "../agent/lib/push-registry.ts";
import { buildTuiAttachmentMessage, createDroppedPathPasteRewriter } from "../agent/lib/tui-attachments.ts";
import { createClankyFaceAnsiTheme, createClankyFaceMarkdownTheme } from "../agent/lib/clanky-face-theme.ts";
import { ClankyBashResultComponent, runFaceBashCommand } from "../agent/lib/clanky-face-bash.ts";
import {
	AGENT_SPINNER_NAMES,
	AGENT_SPINNER_CYCLE_NAME,
	DEFAULT_AGENT_SPINNER_CYCLE_DWELL_MS,
	AGENT_SPINNER_PRESET_NAMES,
	AGENT_SPINNER_PRESETS,
	normalizeAgentSpinnerCycleDwellMs,
	normalizeAgentSpinnerSelection,
	resolveAgentSpinner,
	type AgentSpinnerSelection,
	type ResolvedAgentSpinner,
} from "../agent/lib/agent-spinners.ts";
import {
	ClankyFaceRenderer,
	defaultResponseForInputRequest,
	formatContextUsage,
	formatInputRequests,
	statusLabelForFaceEvent,
	type FaceBlockHandle,
	type FaceRenderSink,
} from "../agent/lib/clanky-face-renderer.ts";
import {
	resolveClankyChromeMouseTarget,
	resolveClankyChromeMouseTargetFromBands,
	resolveClankyCommandRows,
	resolveClankyOverlayFrame,
	resolveClankyOverlayMouseTarget,
	resolveClankyTranscriptMouseTarget,
	resolveClankyTranscriptMouseTargetFromBands,
	resolveClankyTranscriptRows,
	type ClankyFaceBandRows,
	type ClankyOverlayMouseTarget,
} from "../agent/lib/clanky-face-layout.ts";
import { ClankyChromeSelectableComponent, ClankyChromeSelection } from "../agent/lib/clanky-chrome-selection.ts";
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
	type TranscriptUnderfilledAlignment,
} from "../agent/lib/clanky-transcript-viewport.ts";
import { renderClankyOutline } from "../agent/lib/clanky-outline.ts";
import { shouldRouteClankyTranscriptGlobalInput } from "../agent/lib/clanky-transcript-key-routing.ts";
import {
	ALL_CODING_HARNESSES,
	BUILTIN_CODING_HARNESSES,
	CLANKY_CODING_HARNESS_ENV,
	CODING_HARNESS_IDS,
	LAUNCHABLE_CODING_HARNESS_IDS,
	type CodingHarnessEnv,
	type CodingHarnessId,
	type CodingHarnessLauncher,
	type CodingRuntime,
	type LaunchableCodingHarnessId,
	type Performer,
	codingHarnessLauncherEnvKey,
	codingHarnessModelEnvKey,
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
import {
	type HerdrAgentInfo,
	listHerdrAgents,
	spawnClankyWorker,
} from "../agent/tools/herdr_spawn.ts";
import {
	buildTuiContextMessage,
	formatWorkerRosterForBrain,
	TuiLedger,
} from "../agent/lib/clanky-tui-ledger.ts";
import {
	clankyNewSessionCommandOutcome,
	shouldAnnounceNewSessionCommand,
} from "../agent/lib/clanky-command-result.ts";
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
import {
	AGENT_MD_OPTIONS,
	APPROVAL_OPTIONS,
	AUTH_GROUP_OPTIONS,
	AUTH_KEY_OPTIONS,
	AUTH_SECRET_TARGETS,
	AUTH_SUBSCRIPTION_OPTIONS,
	AUTH_TOKEN_OPTIONS,
	type AuthAction,
	type AuthSecretAction,
	BROWSER_BRIDGE_OPTIONS,
	type ClankyConfig,
	CODING_HARNESS_ACTION_OPTIONS,
	CODING_HARNESS_LAUNCHER_OPTIONS,
	CODING_HARNESS_OPTIONS,
	CODING_RUNTIME_OPTIONS,
	DEFAULT_APNS_BUNDLE_ID,
	DEFAULT_APNS_ENVIRONMENT,
	DEFAULT_CLAUDE_MODEL,
	DEFAULT_CODEX_MODEL,
	DEFAULT_GEMINI_MODEL,
	DEFAULT_LOCAL_BASE_URL,
	DEFAULT_LOCAL_CONDUCTOR_MODEL,
	DEFAULT_LOCAL_MODEL,
	DEFAULT_LOCAL_VOICE,
	DEFAULT_LOCAL_VOICE_ASR_MODEL,
	DEFAULT_LOCAL_VOICE_LLM_MODEL,
	DEFAULT_LOCAL_VOICE_SERVER_BASE_URL,
	DEFAULT_LOCAL_VOICE_SMALL_MODEL,
	DEFAULT_OPENAI_IMAGE_MODEL,
	DEFAULT_XAI_MODEL,
	DISCORD_CREDENTIAL_KIND_OPTIONS,
	DISCORD_DM_OPTIONS,
	DISCORD_SCOPE_CLEAR_OPTIONS,
	DISCORD_SCOPE_ENV,
	DISCORD_SCOPE_GROUP_OPTIONS,
	DISCORD_SCOPE_TARGET_ACTION_OPTIONS,
	DISCORD_SCOPE_TARGET_OPTIONS,
	DISCORD_TOKEN_ACTION_OPTIONS,
	DISCORD_TOKEN_VOICE_OPTIONS,
	type DiscordScopeUpdate,
	type DiscordTokenUpdate,
	EFFORT_OPTIONS,
	EFFORT_STATUS_OPTIONS,
	ENTER_IMAGE_MODEL_OPTION,
	GEMINI_MODEL_OPTIONS,
	LAYOUT_HEADER_OPTIONS,
	LAYOUT_INPUT_OPTIONS,
	LAYOUT_OPTIONS,
	LAYOUT_STATUS_OPTIONS,
	LOCAL_EFFORT_OPTIONS,
	LOCAL_EFFORT_STATUS_OPTIONS,
	MCP_CONNECTION_INFO_UNAVAILABLE,
	MCP_DYNAMIC_NAME_RE,
	MCP_TRANSPORT_OPTIONS,
	type McpCommandAction,
	type MenuBackOptions,
	type MenuOption,
	MODEL_ENV_KEY,
	MODEL_OPTIONS,
	PET_OPTIONS,
	PROFILE_OPTIONS,
	PUSH_ACTION_OPTIONS,
	PUSH_APNS_ENV,
	PUSH_APNS_ENV_OPTIONS,
	type PushApnsEnvironment,
	type PushCommandAction,
	SETTINGS_STATUS_COLLAPSE_ICON,
	SETTINGS_STATUS_EXPAND_ICON,
	SETTINGS_STATUS_TOGGLE_VALUE,
	type SubscriptionLoginPromptResult,
	type SubscriptionProvider,
	TRACE_OPTIONS,
	VOICE_EVE_SESSION_OPTIONS,
	VOICE_GROUP_OPTIONS,
	VOICE_GROUPS,
	VOICE_LOCAL_TTS_ENGINE_OPTIONS,
	VOICE_REALTIME_PROVIDER_OPTIONS,
	VOICE_SETTINGS,
	VOICE_TTS_PROVIDER_OPTIONS,
	type VoiceRealtimeProvider,
	type VoiceSetting,
	type VoiceSettingUpdate,
	type VoiceTtsProvider,
	XAI_MODEL_OPTIONS,
} from "./clanky/config-data.ts";
import {
	formatAvailableConnections,
	formatBrowserBridgeStatus,
	formatBrowserBridgeSummary,
	formatError,
	formatIntegrationSummary,
	formatIntegrationTable,
	formatJson,
	integrationSavedMessage,
	isAbortError,
	isEffortLevel,
	isLocalEffortLevel,
	isRecord,
	normalizeCommandToken,
	parseIntegrationBinding,
	parseIntegrationRole,
	parseProvider,
	parseSubscriptionProvider,
	splitArgs,
	truncate,
} from "./clanky/util.ts";

const REPO = process.env.CLANKY_REPO_DIR ?? process.cwd();
const PORT = resolvePort(process.env.CLANKY_EVE_PORT, 2000);
const HOST = `http://127.0.0.1:${PORT}`;
const BIND_HOST = process.env.CLANKY_EVE_HOST?.trim();
const CALLBACK_PROXY_PORT = resolvePort(process.env.CLANKY_EVE_CALLBACK_PROXY_PORT, 3000);
const HEALTH_TIMEOUT_MS = resolveDurationMs(process.env.CLANKY_EVE_HEALTH_TIMEOUT_MS, 180_000, "CLANKY_EVE_HEALTH_TIMEOUT_MS");
const SERVER_STOP_TIMEOUT_MS = resolveDurationMs(process.env.CLANKY_EVE_STOP_TIMEOUT_MS, 5_000, "CLANKY_EVE_STOP_TIMEOUT_MS");
const INTENTIONAL_RESTART_STOP_TIMEOUT_MS = resolveDurationMs(process.env.CLANKY_EVE_RESTART_STOP_TIMEOUT_MS, 1_000, "CLANKY_EVE_RESTART_STOP_TIMEOUT_MS");
const SERVER_KILL_TIMEOUT_MS = resolveDurationMs(process.env.CLANKY_EVE_KILL_TIMEOUT_MS, 2_000, "CLANKY_EVE_KILL_TIMEOUT_MS");
const DEV_SERVER_RECORD_STARTUP_GRACE_MS = 15_000;
const DEV_SERVER_UNHEALTHY_SETTLE_MS = 5_000;
const DEV_SERVER_RECORD_REPROBE_MS = 500;
const BRAIN_HEALTH_POLL_MS = resolveDurationMs(process.env.CLANKY_EVE_HEALTH_POLL_MS, 5_000, "CLANKY_EVE_HEALTH_POLL_MS");
const ENV_PATH = join(REPO, ".env.local");
const DEV_SERVER_FILE = join(REPO, ".eve", "dev-server.json");
const OWNED_SERVER_STARTUP_OUTPUT_LIMIT = 8_000;
const DEFAULT_TURN_TRACE_MODE: TurnTraceMode = "no-reply";
const CLANKY_FACE_HERDR_PANE_ID_ENV = "CLANKY_FACE_HERDR_PANE_ID";
const CLANKY_FACE_HERDR_TAB_ID_ENV = "CLANKY_FACE_HERDR_TAB_ID";
const CLANKY_FACE_HERDR_WORKSPACE_ID_ENV = "CLANKY_FACE_HERDR_WORKSPACE_ID";
const CLANKY_TUI_INPUT_PLACEMENT_ENV = "CLANKY_TUI_INPUT_PLACEMENT";
const CLANKY_TUI_STATUS_PLACEMENT_ENV = "CLANKY_TUI_STATUS_PLACEMENT";
const CLANKY_TUI_SPINNER_ENV = "CLANKY_TUI_SPINNER";
const CLANKY_TUI_SPINNER_RATE_MS_ENV = "CLANKY_TUI_SPINNER_RATE_MS";
const CLANKY_STARTUP_MODEL_FALLBACK_PROVIDER_ENV = "CLANKY_STARTUP_MODEL_FALLBACK_PROVIDER";
const CLANKY_STARTUP_MODEL_FALLBACK_ENV_NAMES_ENV = "CLANKY_STARTUP_MODEL_FALLBACK_ENV_NAMES";
const SPAWN_USAGE =
	"Usage: /spawn --harness <clanky|claude|codex|opencode|custom> [--cwd path] <slug> <task>. Run /spawn with no args for the menu. Slug is kebab-case; the pane is clanky:<slug>.";
const SPAWN_SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;
// Mode 1002 reports drag motion while a button is held (1000 only reports
// press/release), which the transcript needs to track a selection gesture.
const CLANKY_MOUSE_TRACKING_ENABLE = "\x1b[?1002h\x1b[?1006h";
const CLANKY_MOUSE_TRACKING_DISABLE = "\x1b[?1002l\x1b[?1006l";
const MIN_TRANSCRIPT_ROWS = 4;
const AGENTS_PANEL_WIDTH = 76;
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

const markdownTheme: MarkdownTheme = createClankyFaceMarkdownTheme(ansi);

const commandUiTheme = {
	bold: ansi.bold,
	cyan: ansi.cyan,
	dim: ansi.dim,
	green: ansi.green,
	red: ansi.red,
	selectedDescription: ansi.selectedDescription,
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

function parseAgentSpinnerCycleRateMs(value: string | undefined): number | undefined {
	const raw = value?.trim().toLowerCase();
	if (raw === undefined || raw.length === 0) return undefined;
	if (raw === "fast") return 400;
	if (raw === "normal" || raw === "default") return DEFAULT_AGENT_SPINNER_CYCLE_DWELL_MS;
	if (raw === "slow") return 1_200;
	const milliseconds = raw.endsWith("ms") ? Number.parseInt(raw.slice(0, -2), 10) : undefined;
	if (milliseconds !== undefined && Number.isInteger(milliseconds) && `${milliseconds}ms` === raw) return validAgentSpinnerCycleRateMs(milliseconds);
	if (raw.endsWith("s")) {
		const seconds = Number.parseFloat(raw.slice(0, -1));
		if (Number.isFinite(seconds) && seconds > 0 && `${seconds}s` === raw) return validAgentSpinnerCycleRateMs(Math.round(seconds * 1_000));
	}
	const parsed = Number.parseInt(raw, 10);
	if (Number.isInteger(parsed) && String(parsed) === raw) return validAgentSpinnerCycleRateMs(parsed);
	return undefined;
}

function validAgentSpinnerCycleRateMs(value: number): number | undefined {
	const normalized = normalizeAgentSpinnerCycleDwellMs(value);
	return normalized === value ? value : undefined;
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

function parseInputPlacement(value: string | undefined): InputPlacement | undefined {
	const normalized = value?.trim().toLowerCase();
	if (normalized === "top" || normalized === "above") return "top";
	if (normalized === "bottom" || normalized === "below") return "bottom";
	return undefined;
}

function parseStatusPlacement(value: string | undefined): StatusPlacement | undefined {
	const normalized = value?.trim().toLowerCase().replace(/_/gu, "-");
	if (normalized === "above" || normalized === "above-input" || normalized === "top") return "above-input";
	if (normalized === "below" || normalized === "below-input" || normalized === "bottom") return "below-input";
	return undefined;
}

function layoutSettingsFromEnv(env: NodeJS.ProcessEnv): LayoutSettings {
	return {
		inputPlacement: parseInputPlacement(env[CLANKY_TUI_INPUT_PLACEMENT_ENV]) ?? "bottom",
		statusPlacement: parseStatusPlacement(env[CLANKY_TUI_STATUS_PLACEMENT_ENV]) ?? "above-input",
	};
}

type ClankyExtensionCommandName =
	| "discord-token"
	| "discord-scope"
	| "auth"
	| "login"
	| "model"
	| "profile"
	| "harness"
	| "effort"
	| "approvals"
	| "agent-md"
	| "image-model"
	| "video-model"
	| "vision-model"
	| "voice"
	| "push"
	| "integrations"
	| "mcp"
	| "browser"
	| "trace"
	| "pet"
	| "layout"
	| "skills"
	| "agents"
	| "spawn"
	| "pair"
	| "status";
type ClankyExtensionCommand = {
	type: "extension";
	name: ClankyExtensionCommandName;
	argument: string;
};
type NativePromptCommand =
	| { type: "help" }
	| { type: "new"; quiet?: boolean }
	| { type: "resume"; argument: string }
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
	readonly component?: Component;
	readonly exit?: boolean;
	readonly ledgerMessage?: string;
	readonly message?: string;
	readonly newSession?: boolean;
	readonly announceNewSession?: boolean;
	readonly resumeSession?: SessionState;
	readonly resumeLabel?: string;
};
type CommandLogTone = "error" | "success";

type CommandRenderer = {
	readonly setupFlow: SetupFlow | undefined;
	setConnectionAuthPendingCount?(count: number): void;
	upsertConnectionAuth?(state: ConnectionAuthState): void;
};

type ActivePromptTurn = {
	readonly controller: AbortController;
	readonly loader: Loader;
	readonly loaderBlock: ClankyTranscriptBlockHandle;
	readonly prompt: string;
	readonly userBlock: FaceBlockHandle;
	promptRestoreEligible: boolean;
};

type FaceSessionPersistence = {
	readonly label?: string;
	readonly lastPrompt?: string;
};

type ShutdownOptions = {
	readonly abortTurn?: boolean;
	readonly waitForTurn?: boolean;
};

type StartupModelFallback = {
	readonly provider: "xai" | "gemini";
	readonly envNames: string;
};

type ConnectionAuthState = {
	readonly name: string;
	readonly description?: string;
	readonly state: "required" | "authorized" | "declined" | "failed" | "timed-out";
	readonly challenge?: MappedConnectionAuthChallenge;
	readonly reason?: string;
};

type SelectableOverlayEntry = {
	hidden: boolean;
	readonly component: ClankyChromeSelectableComponent;
	readonly options?: OverlayOptions;
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
		readonly allowBack?: boolean;
		readonly validate?: (value: string) => string | undefined;
	}): Promise<string | undefined>;
	readSelect(options: {
		readonly kind: "multi" | "single";
		readonly message: string;
		readonly options: readonly MenuOption[];
		readonly statusActions?: readonly MenuOption[];
		readonly initialValue?: string;
		readonly initialValues?: readonly string[];
		readonly currentValue?: string;
		readonly currentValues?: readonly string[];
		readonly required?: boolean;
		readonly allowBack?: boolean;
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



type BrainHealthState =
	| { state: "unknown"; checkedAt?: number }
	| { state: "restarting"; checkedAt: number; detail?: string }
	| { state: "healthy"; checkedAt: number }
	| { state: "unhealthy"; checkedAt: number; status: number; statusText: string; detail?: string }
	| { state: "down"; checkedAt: number; detail: string };

type TurnTraceMode = "off" | "no-reply" | "all";
type InputPlacement = "top" | "bottom";
type StatusPlacement = "above-input" | "below-input";
type LayoutSettings = {
	readonly inputPlacement: InputPlacement;
	readonly statusPlacement: StatusPlacement;
};

type SettingsMenuStatus =
	| string
	| {
			readonly collapsed: string;
			readonly expanded: string;
			readonly expandLabel?: string;
			readonly collapseLabel?: string;
		};

const STATUS_BAR_MAX_ROWS = 6;

class ClankyStatusBarComponent implements Component {
	private text = "";

	setText(text: string): void {
		this.text = text;
	}

	invalidate(): void {}

	render(width: number): string[] {
		if (this.text.trim().length === 0) return [];
		const topSpacer = this.text.startsWith("\n");
		const bottomSpacer = this.text.endsWith("\n");
		const content = this.text.replace(/^\n/u, "").replace(/\n$/u, "");
		const blank = " ".repeat(Math.max(1, width));
		return [
			...(topSpacer ? [blank] : []),
			...formatStatusRows(content, width),
			...(bottomSpacer ? [blank] : []),
		];
	}
}

interface DevServerRecord {
	readonly pid: number;
	readonly updatedAt?: string;
	readonly url: string;
}

interface DiscoveredHost {
	readonly host: string;
	readonly record: DevServerRecord;
	readonly source: string;
	readonly state: "healthy" | "reachable";
}


let server: ChildProcess | null = null;
let callbackProxyServer: HttpServer | null = null;
let ownsServer = false;
let startupModelFallback: StartupModelFallback | undefined = startupModelFallbackFromEnv(process.env);
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
let herdrSessionNameCache: string | undefined;
let herdrWorkspaceNameCache: string | null | undefined;
let uiReady = false;
let turnTraceMode = parseTurnTraceMode(process.env.CLANKY_TURN_TRACE) ?? DEFAULT_TURN_TRACE_MODE;
let headerVisible = parseBooleanFlag(process.env.CLANKY_HEADER) ?? true;
let layoutSettings: LayoutSettings = layoutSettingsFromEnv(process.env);
let agentSpinnerCycleRateMs = parseAgentSpinnerCycleRateMs(process.env[CLANKY_TUI_SPINNER_RATE_MS_ENV]) ?? DEFAULT_AGENT_SPINNER_CYCLE_DWELL_MS;
let agentSpinner: ResolvedAgentSpinner = resolveAgentSpinner(process.env[CLANKY_TUI_SPINNER_ENV], { unicode: faceCapabilities.unicode, cycleDwellMs: agentSpinnerCycleRateMs });
let runningTurn: Promise<void> | undefined;
let isResponding = false;
let activeTurn: ActivePromptTurn | undefined;
let shutdownStarted = false;
const tuiLedger = new TuiLedger();
let activeLoader: Loader | undefined;
// Inline shell escape (`!`): in bash mode a submitted line runs as a host shell
// command in REPO instead of a brain prompt. `activeBashChild` is the in-flight
// command (so Ctrl-C kills it instead of quitting); `bashRunning` counts live
// commands for the status indicator.
let bashMode = false;
let activeBashChild: ChildProcess | undefined;
let bashRunning = 0;
let commandPaletteOverlay: OverlayHandle | undefined;
let commandTypeaheadState: ClankyCommandTypeaheadState | undefined;
let currentStatusLabel = "starting";
let connectionAuthPendingCount = 0;
let mouseTrackingEnabled = false;
let transcriptSelectionActive = false;
let transcriptSelectionDragged = false;
let transcriptClickTarget: { readonly col: number; readonly row: number } | undefined;
let chromeSelectionActive = false;
const chromeSelection = new ClankyChromeSelection();
const selectableOverlays: SelectableOverlayEntry[] = [];
const IMAGE_PROVIDERS = ["openai", "xai", "gemini"] as const;
type ImageProvider = (typeof IMAGE_PROVIDERS)[number];
const IMAGE_MODEL_ENV: Record<ImageProvider, string> = {
	openai: "CLANKY_OPENAI_IMAGE_MODEL",
	xai: "CLANKY_XAI_IMAGE_MODEL",
	gemini: "CLANKY_GEMINI_IMAGE_MODEL",
};
const IMAGE_MODEL_DEFAULT: Record<ImageProvider, string> = {
	openai: DEFAULT_OPENAI_IMAGE_MODEL,
	xai: "grok-imagine-image-quality",
	gemini: "gemini-3.1-flash-image",
};
const IMAGE_PROVIDER_OPTIONS: readonly MenuOption[] = [
	{ value: "openai", label: "openai", hint: "OpenAI gpt-image" },
	{ value: "xai", label: "xai", hint: "Grok Imagine" },
	{ value: "gemini", label: "gemini", hint: "Nano Banana" },
];
const IMAGE_MODEL_OPTIONS: Record<ImageProvider, readonly MenuOption[]> = {
	openai: [
		{ value: DEFAULT_OPENAI_IMAGE_MODEL, label: DEFAULT_OPENAI_IMAGE_MODEL },
		{ value: ENTER_IMAGE_MODEL_OPTION, label: "enter model id" },
	],
	xai: [
		{ value: "grok-imagine-image-quality", label: "grok-imagine-image-quality" },
		{ value: "grok-imagine-image-fast", label: "grok-imagine-image-fast" },
		{ value: ENTER_IMAGE_MODEL_OPTION, label: "enter model id" },
	],
	gemini: [
		{ value: "gemini-3.1-flash-image", label: "gemini-3.1-flash-image", hint: "nano banana 2" },
		{ value: "gemini-3-pro-image", label: "gemini-3-pro-image", hint: "nano banana pro" },
		{ value: ENTER_IMAGE_MODEL_OPTION, label: "enter model id" },
	],
};
const DEFAULT_XAI_VIDEO_MODEL = "grok-imagine-video";
const VIDEO_MODEL_OPTIONS: readonly MenuOption[] = [
	{ value: DEFAULT_XAI_VIDEO_MODEL, label: DEFAULT_XAI_VIDEO_MODEL },
	{ value: ENTER_IMAGE_MODEL_OPTION, label: "enter model id" },
];
const AGENTS_TOGGLE_VALUE = "__agents_toggle_others__";
let baseClient: Client;
let client: Client;
let session: ClientSession;
let currentSessionLabel: string | undefined;
let faceRenderer: ClankyFaceRenderer;
const FACE_SESSION_STORE_PATH = resolveClankyDataPath("tui/sessions.json");
const FACE_SESSION_STORE_LIMIT = 30;
const FACE_SESSION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

const COMMANDS = buildClankyPromptCommands();

if (process.argv.includes("--command-host")) {
	await runCommandHost();
	process.exit(0);
}

if (process.stdin.isTTY !== true || process.stdout.isTTY !== true) {
	process.stderr.write("clanky: interactive Clanky face requires a TTY; use `clanky worker ...` or `clanky status` for noninteractive use\n");
	process.exit(1);
}

process.stdout.write("\x1b[2mstarting Clanky...\x1b[22m\n");
await reportClankyFaceToHerdr("working", "starting Clanky face");
await refreshEffortStatusSuffix();
ownsServer = await ensureServer();
await startCallbackProxy();
await reportClankyFaceToHerdr("idle", "Clanky face ready");

baseClient = new Client({ host: brainHost, preserveCompletedSessions: true });
client = createAttachmentAwareClient(baseClient);
const initialInfo = await fetchInfo();
if (initialInfo !== undefined) updateLatestInfo(initialInfo);
session = client.session();

const faceEnv = await readFaceEnv();
headerVisible = parseBooleanFlag(faceEnv.CLANKY_HEADER) ?? headerVisible;
layoutSettings = layoutSettingsFromEnv(faceEnv);
agentSpinnerCycleRateMs = parseAgentSpinnerCycleRateMs(faceEnv[CLANKY_TUI_SPINNER_RATE_MS_ENV]) ?? agentSpinnerCycleRateMs;
agentSpinner = resolveAgentSpinner(faceEnv[CLANKY_TUI_SPINNER_ENV], { unicode: faceCapabilities.unicode, cycleDwellMs: agentSpinnerCycleRateMs });

const tui = new TUI(new ProcessTerminal());
tui.setClearOnShrink(true);
const banner = new ClankyBannerComponent(buildBannerFields(latestInfo), faceCapabilities, headerVisible);
const status = new ClankyStatusBarComponent();
const editor = new Editor(tui, editorTheme, { autocompleteMaxVisible: 12 });
const commandTypeaheadPanel = new ClankyCommandTypeaheadPanel(COMMANDS, commandUiTheme, {
	maxVisibleRows: maxCommandTypeaheadRows,
});
const selectableBanner = new ClankyChromeSelectableComponent(banner, "banner", chromeSelection);
const selectableStatus = new ClankyChromeSelectableComponent(status, "status", chromeSelection);
const selectableTypeahead = new ClankyChromeSelectableComponent(commandTypeaheadPanel, "typeahead", chromeSelection);
const transcriptViewport = new ClankyTranscriptViewport(maxTranscriptRows, {
	dim: ansi.dim,
	selected: ansi.cyan,
}, { blockSpacing: 1, underfilledAlignment: transcriptUnderfilledAlignment() });
faceRenderer = new ClankyFaceRenderer(createFaceRenderSink());
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
if (startupModelFallback !== undefined) {
	insertMarkdown(formatStartupModelFallbackNotice(startupModelFallback));
}

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

applyFaceLayout();
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
		handleSelectionMouse(mouse);
		return { consume: true };
	}
	if (matchesKey(data, Key.ctrl("c")) && (transcriptViewport.hasSelection() || chromeSelection.hasSelection())) {
		if (transcriptViewport.hasSelection()) {
			void copyTranscriptSelection();
			transcriptViewport.clearSelection();
		} else {
			void copyChromeSelection();
			chromeSelection.clear();
		}
		tui.requestRender();
		return { consume: true };
	}
	if (matchesKey(data, Key.escape) && (transcriptViewport.hasSelection() || chromeSelection.hasSelection())) {
		transcriptViewport.clearSelection();
		chromeSelection.clear();
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
	// A running `!` shell command owns Ctrl-C: kill it instead of quitting Clanky.
	if (matchesKey(data, Key.ctrl("c")) && activeBashChild !== undefined) {
		activeBashChild.kill("SIGINT");
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
		void shutdown(0, { abortTurn: true, waitForTurn: false });
		return { consume: true };
	}
	if (matchesKey(data, Key.escape) && setupFlow.isWaitingForInput()) {
		setupFlow.handleSubmit("/cancel");
		return { consume: true };
	}
	if (matchesKey(data, Key.escape) && handleActiveTurnEscape()) return { consume: true };
	const bashInput = handleBashModeInput(data);
	if (bashInput !== undefined) return bashInput;
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
// Announce this face to the brain so the iOS app can show headless vs attached.
// Reconnects across brain restarts and host changes via the getters.
startFacePresence({ host: () => brainHost, token: resolveRelayTokenSync, pid: process.pid, role: "face-command-host", onCommandRequest: runRemoteFaceCommand });
refreshStatus("ready");
tui.start();
enableClankyMouseTracking();
const handleProcessShutdownSignal = (): void => {
	void shutdown(0, { abortTurn: true, waitForTurn: false });
};
process.once("SIGINT", handleProcessShutdownSignal);
process.once("SIGTERM", handleProcessShutdownSignal);

function resolveRelayTokenSync(): string {
	const fromEnv = process.env.CLANKY_RELAY_TOKEN;
	if (fromEnv !== undefined && fromEnv.trim().length > 0) return fromEnv;
	try {
		return parseEnv(readFileSync(ENV_PATH, "utf8")).CLANKY_RELAY_TOKEN ?? "";
	} catch {
		return "";
	}
}

async function runCommandHost(): Promise<void> {
	process.stdout.write("\x1b[2mstarting Clanky command host...\x1b[22m\n");
	await reportClankyFaceToHerdr("working", "starting Clanky command host");
	await refreshEffortStatusSuffix();
	ownsServer = await ensureServer();
	await startCallbackProxy();

	baseClient = new Client({ host: brainHost, preserveCompletedSessions: true });
	client = createAttachmentAwareClient(baseClient);
	const initialInfo = await fetchInfo();
	if (initialInfo !== undefined) updateLatestInfo(initialInfo);
	session = client.session();
	faceRenderer = new ClankyFaceRenderer(createHeadlessFaceRenderSink());

	startFacePresence({ host: () => brainHost, token: resolveRelayTokenSync, pid: process.pid, role: "command-host", onCommandRequest: runRemoteFaceCommand });
	await reportClankyFaceToHerdr("idle", "Clanky command host ready");
	process.stdout.write(`\x1b[2mClanky command host ready · eve server ${brainHost.replace(/^https?:\/\//u, "")}\x1b[22m\n`);

	await waitForCommandHostShutdown();
}

function createHeadlessFaceRenderSink(): FaceRenderSink {
	return {
		insertMarkdown(markdown: string): FaceBlockHandle {
			process.stdout.write(`${stripAnsi(markdown)}\n`);
			return {
				setMarkdown(nextMarkdown: string): void {
					process.stdout.write(`${stripAnsi(nextMarkdown)}\n`);
				},
			};
		},
		setLoaderMessage(): void {},
		setStatus(message: string): void {
			currentStatusLabel = message;
		},
	};
}

async function waitForCommandHostShutdown(): Promise<void> {
	await new Promise<void>((resolve) => {
		const finish = (): void => {
			process.off("SIGINT", finish);
			process.off("SIGTERM", finish);
			resolve();
		};
		process.once("SIGINT", finish);
		process.once("SIGTERM", finish);
	});
	stopFacePresence();
	await stopCallbackProxy();
	if (ownsServer) await stopServer();
	await reportClankyFaceToHerdr("unknown", "Clanky command host stopped");
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
			name: "n",
			aliases: [],
			description: "Start a fresh session and clear the transcript",
			takesArgument: false,
			build: () => ({ type: "new", quiet: true }),
		},
		{
			name: "new",
			aliases: [],
			description: "Start a fresh session and clear the transcript",
			takesArgument: false,
			build: () => ({ type: "new" }),
		},
		{
			name: "resume",
			aliases: ["r"],
			description: "Resume a saved Clanky session",
			argumentHint: "[list|<number|session-id>]",
			takesArgument: true,
			build: (argument) => ({ type: "resume", argument }),
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
			argumentHint: "[status|<token>] [--user-token] [--voice]",
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
			description: "Choose Clanky's brain route, model, and required route auth",
			argumentHint: "[status|codex|claude|local|xai|gemini] [id] [effort]",
			takesArgument: true,
			build: (argument) => ({ type: "extension", name: "model", argument }),
		},
		{
			name: "auth",
			aliases: ["credentials", "creds", "keys"],
			description: "Manage subscription logins, API keys, and service credentials",
			argumentHint: "[status|codex|claude|xai|gemini|openai|discord|mcp|elevenlabs|relay|local-voice]",
			takesArgument: true,
			build: (argument) => ({ type: "extension", name: "auth", argument }),
		},
		{
			name: "profile",
			aliases: [],
			description: "Switch conductor and voice between local and hosted API profiles",
			argumentHint: "[status|local-tiered|local-single|api|local-api|api-local] [model]",
			takesArgument: true,
			build: (argument) => ({ type: "extension", name: "profile", argument }),
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
			name: "agents",
			aliases: ["workers"],
			description: "Browse herdr agents; tag one as context for your next message",
			argumentHint: "[all]",
			takesArgument: true,
			build: (argument) => ({ type: "extension", name: "agents", argument }),
		},
		{
			name: "spawn",
			aliases: [],
			description: "Spawn a herdr worker pane through the transcript seam",
			argumentHint: "--harness <clanky|claude|codex|opencode|custom> [--cwd path] <slug> <task>",
			takesArgument: true,
			build: (argument) => ({ type: "extension", name: "spawn", argument }),
		},
		{
			name: "login",
			aliases: [],
			description: "Authorize a subscription provider (Claude or Codex)",
			argumentHint: "[claude|codex|status]",
			takesArgument: true,
			build: (argument) => ({ type: "extension", name: "login", argument }),
		},
		{
			name: "effort",
			aliases: [],
			description: "Set reasoning effort for Codex or local routes",
			argumentHint: "[status|minimal|low|medium|high|xhigh|unset]",
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
			name: "agent-md",
			aliases: ["agent-files", "agents-md"],
			description: "Toggle AGENTS.md/agent.md instruction ingestion",
			argumentHint: "[on|off|status|root <path>|clear-root]",
			takesArgument: true,
			build: (argument) => ({ type: "extension", name: "agent-md", argument }),
		},
		{
			name: "skills",
			aliases: ["skill"],
			description: "Show Clanky's skills",
			takesArgument: false,
			build: () => ({ type: "extension", name: "skills", argument: "" }),
		},
		{
			name: "image-model",
			aliases: ["images"],
			description: "Set the image generation provider/model (openai, xai, gemini)",
			argumentHint: "[status|openai|xai|gemini] [model-id]",
			takesArgument: true,
			build: (argument) => ({ type: "extension", name: "image-model", argument }),
		},
		{
			name: "video-model",
			aliases: ["video"],
			description: "Set the video generation provider/model (xai)",
			argumentHint: "[status|xai] [model-id]",
			takesArgument: true,
			build: (argument) => ({ type: "extension", name: "video-model", argument }),
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
			argumentHint: "[status|mode|model|realtime-voice|tts|elevenlabs|memory|eve-session] [value]",
			takesArgument: true,
			build: (argument) => ({ type: "extension", name: "voice", argument }),
		},
		{
			name: "push",
			aliases: ["notifications", "apns"],
			description: "Configure iOS push notifications and APNs credentials",
			argumentHint: "[status|test|key-path|key-id|team-id|bundle-id|env|clear] [value]",
			takesArgument: true,
			build: (argument) => ({ type: "extension", name: "push", argument }),
		},
		{
			name: "integrations",
			aliases: [],
			description: "Bind integration roles to connections",
			argumentHint: "[status|role] [connection|unset]",
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
			name: "layout",
			aliases: ["header", "banner"],
			description: "Configure header, chat input, and status bar placement",
			argumentHint: "[status|input top|input bottom|status above|status below|header on|header off]",
			takesArgument: true,
			build: (argument) => ({ type: "extension", name: "layout", argument }),
		},
		{
			name: "pair",
			aliases: [],
			description: "Show a QR (or 'link') the Clanky iOS app scans to connect",
			argumentHint: "[link]",
			takesArgument: true,
			build: (argument) => ({ type: "extension", name: "pair", argument }),
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
	commandPaletteOverlay = showSelectableOverlay(workbench, {
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

function showSelectableOverlay(component: Component, options?: OverlayOptions): OverlayHandle {
	const selectable = new ClankyChromeSelectableComponent(component, "modal", chromeSelection);
	const entry: SelectableOverlayEntry = { component: selectable, hidden: false, ...(options === undefined ? {} : { options }) };
	selectableOverlays.push(entry);
	const handle = tui.showOverlay(selectable, options);
	let registered = true;
	const unregister = (): void => {
		if (!registered) return;
		registered = false;
		const index = selectableOverlays.indexOf(entry);
		if (index >= 0) selectableOverlays.splice(index, 1);
		chromeSelection.clearBand("modal");
		chromeSelectionActive = false;
	};
	return {
		hide(): void {
			unregister();
			handle.hide();
		},
		setHidden(hidden: boolean): void {
			entry.hidden = hidden;
			if (hidden) {
				chromeSelection.clearBand("modal");
				chromeSelectionActive = false;
			}
			handle.setHidden(hidden);
		},
		isHidden(): boolean {
			return handle.isHidden();
		},
		focus(): void {
			handle.focus();
		},
		unfocus(options): void {
			handle.unfocus(options);
		},
		isFocused(): boolean {
			return handle.isFocused();
		},
	};
}

function toggleTranscriptFocus(): void {
	if (transcriptViewport.focused) tui.setFocus(editor);
	else tui.setFocus(transcriptViewport);
	refreshStatusView();
	tui.requestRender();
}

function handleSelectionMouse(mouse: ClankySgrMouseEvent): void {
	if (!isClankyLeftMouseButton(mouse)) return;
	if (mouse.kind === "press") {
		const modal = modalMouseTarget(mouse);
		if (modal !== null) {
			transcriptViewport.clearSelection();
			transcriptSelectionActive = false;
			transcriptSelectionDragged = false;
			transcriptClickTarget = undefined;
			chromeSelection.press("modal", modal.row, modal.col);
			chromeSelectionActive = true;
		} else {
			const transcript = transcriptMouseTarget(mouse);
			if (transcript.inside) {
				chromeSelection.clear();
				chromeSelectionActive = false;
				transcriptViewport.selectionPress(transcript.row, transcript.col);
				transcriptSelectionActive = true;
				transcriptSelectionDragged = false;
				transcriptClickTarget = { col: transcript.col, row: transcript.row };
			} else {
				transcriptViewport.clearSelection();
				transcriptSelectionActive = false;
				transcriptSelectionDragged = false;
				transcriptClickTarget = undefined;
				const chrome = chromeMouseTarget(mouse);
				if (chrome !== null) {
					chromeSelection.press(chrome.band, chrome.row, chrome.col);
					chromeSelectionActive = true;
				} else {
					chromeSelection.clear();
					chromeSelectionActive = false;
				}
			}
		}
		tui.requestRender();
		return;
	}
	if (mouse.kind === "drag") {
		if (transcriptSelectionActive) {
			transcriptSelectionDragged = true;
			const transcript = transcriptMouseTarget(mouse);
			transcriptViewport.selectionDrag(transcript.row, transcript.col);
			tui.requestRender();
			return;
		}
		if (chromeSelectionActive) {
			const modal = modalMouseTarget(mouse);
			if (modal !== null) {
				chromeSelection.drag("modal", modal.row, modal.col);
			} else {
				const chrome = chromeMouseTarget(mouse);
				if (chrome !== null) chromeSelection.drag(chrome.band, chrome.row, chrome.col);
			}
			tui.requestRender();
		}
		return;
	}
	// release
	if (transcriptSelectionActive) {
		transcriptSelectionActive = false;
		if (transcriptViewport.hasSelection()) {
			void copyTranscriptSelection();
		} else if (!transcriptSelectionDragged && transcriptClickTarget !== undefined) {
			const release = transcriptMouseTarget(mouse);
			if (!release.inside || release.row !== transcriptClickTarget.row || !transcriptViewport.toggleCollapsedAt(transcriptClickTarget.row)) {
				transcriptViewport.clearSelection();
			}
		} else {
			transcriptViewport.clearSelection();
		}
		transcriptSelectionDragged = false;
		transcriptClickTarget = undefined;
		tui.requestRender();
		return;
	}
	if (chromeSelectionActive) {
		chromeSelectionActive = false;
		if (chromeSelection.hasSelection()) void copyChromeSelection();
		else chromeSelection.clear();
		tui.requestRender();
	}
}

function modalMouseTarget(mouse: ClankySgrMouseEvent): ClankyOverlayMouseTarget | null {
	const terminalColumns = tui.terminal.columns;
	const terminalRows = tui.terminal.rows;
	for (let index = selectableOverlays.length - 1; index >= 0; index--) {
		const overlay = selectableOverlays[index];
		if (overlay === undefined || overlay.hidden || overlay.options?.visible?.(terminalColumns, terminalRows) === false) continue;
		const frame = resolveClankyOverlayFrame({
			options: overlay.options,
			overlayRows: 0,
			terminalColumns,
			terminalRows,
		});
		const overlayRows = overlay.component.render(frame.width).length;
		const target = resolveClankyOverlayMouseTarget({
			mouseCol: mouse.col,
			mouseRow: mouse.row,
			options: overlay.options,
			overlayRows,
			terminalColumns,
			terminalRows,
		});
		if (target !== null) return target;
	}
	return null;
}

function applyFaceLayout(): void {
	transcriptViewport.setUnderfilledAlignment(transcriptUnderfilledAlignment());
	syncBannerChromePadding();
	for (const component of rootFaceComponents()) tui.removeChild(component);
	for (const component of orderedFaceComponents()) tui.addChild(component);
	tui.setFocus(editor);
	if (uiReady) tui.requestRender();
}

function orderedFaceComponents(): Component[] {
	const statusAboveInput = layoutSettings.statusPlacement === "above-input";
	if (layoutSettings.inputPlacement === "top") {
		const topControls = statusAboveInput
			? [selectableStatus, editor, selectableTypeahead]
			: [editor, selectableStatus, selectableTypeahead];
		return [selectableBanner, ...topControls, transcriptViewport];
	}
	const bottomControls = statusAboveInput
		? [selectableTypeahead, selectableStatus, editor]
		: [selectableTypeahead, editor, selectableStatus];
	return [selectableBanner, transcriptViewport, ...bottomControls];
}

function rootFaceComponents(): Component[] {
	return [selectableBanner, transcriptViewport, selectableStatus, selectableTypeahead, editor];
}

function transcriptUnderfilledAlignment(): TranscriptUnderfilledAlignment {
	return layoutSettings.inputPlacement === "top" ? "top" : "bottom";
}

function syncBannerChromePadding(): void {
	const compactBelowHeader = layoutSettings.inputPlacement === "top" && layoutSettings.statusPlacement === "above-input";
	banner.setVerticalPadding({ bottom: compactBelowHeader ? 0 : 1, top: 1 });
}

function layoutBandRows(width: number): ClankyFaceBandRows[] {
	return orderedFaceComponents().map((component) => {
		if (component === selectableBanner) return { band: "banner", rows: banner.render(width).length };
		if (component === transcriptViewport) return { band: "transcript", rows: maxTranscriptRows(width) };
		if (component === selectableStatus) return { band: "status", rows: status.render(width).length };
		if (component === selectableTypeahead) return { band: "typeahead", rows: commandTypeaheadPanel.render(width).length };
		return { band: "editor", rows: editor.render(width).length };
	});
}

function chromeMouseTarget(mouse: ClankySgrMouseEvent): ReturnType<typeof resolveClankyChromeMouseTarget> {
	const width = tui.terminal.columns;
	return resolveClankyChromeMouseTargetFromBands({
		bands: layoutBandRows(width),
		mouseCol: mouse.col,
		mouseRow: mouse.row,
		terminalRows: tui.terminal.rows,
	});
}

function transcriptMouseTarget(mouse: ClankySgrMouseEvent): ReturnType<typeof resolveClankyTranscriptMouseTarget> {
	const width = tui.terminal.columns;
	return resolveClankyTranscriptMouseTargetFromBands({
		bands: layoutBandRows(width),
		mouseCol: mouse.col,
		mouseRow: mouse.row,
		terminalRows: tui.terminal.rows,
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

async function copyChromeSelection(): Promise<void> {
	const text = chromeSelection.getSelectedText();
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
				allowBack: options.allowBack,
				defaultValue,
				error,
				message: options.message,
				onCancel: cancel,
				onRender: () => tui.requestRender(),
				onSubmit: (value) => finish(value),
				placeholder: options.placeholder,
			});
			handle = showSelectableOverlay(prompt, setupOverlayOptions("center"));
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
				allowBack: options.allowBack,
				currentValue: options.currentValue,
				currentValues: options.currentValues,
				initialValue: options.initialValue,
				initialValues: options.initialValues,
				kind: options.kind,
				message: options.message,
				onCancel: cancel,
				onRender: () => tui.requestRender(),
				onSubmit: (values) => finish(values),
				options: options.options.map(toInteractivePromptOption),
				required: options.required,
				statusActions: options.statusActions?.map(toInteractivePromptOption),
				theme: selectListTheme,
			});
			handle = showSelectableOverlay(prompt, setupOverlayOptions("center"));
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

function insertMarkdown(text: string, options?: ClankyTranscriptBlockOptions): FaceBlockHandle {
	const component = new ClankyTranscriptMarkdownBlock(text, {
		bold: ansi.bold,
		cyan: ansi.cyan,
		dim: ansi.dim,
		green: ansi.green,
		loadingGlyph: () => currentAgentSpinnerFrame().trimEnd() || "◜",
		markdown: markdownTheme,
		red: ansi.red,
		yellow: ansi.yellow,
	});
	const block = insertTranscript(component, options);
	tui.requestRender();
	return {
		remove(): void {
			block.remove();
			tui.requestRender();
		},
		setMarkdown(markdown: string): void {
			component.setMarkdown(markdown);
			tui.requestRender();
		},
	};
}

function insertCommandResult(prompt: string, message: string, tone: CommandLogTone): void {
	insertTranscript(new ClankyCommandTextResultComponent(prompt, message, tone));
	tui.requestRender();
}

function insertCommandComponent(prompt: string, component: Component, tone: CommandLogTone): void {
	insertTranscript(new ClankyCommandResultComponent(prompt, tone, component));
	tui.requestRender();
}

class ClankyCommandResultComponent implements Component {
	private readonly prompt: string;
	private readonly tone: CommandLogTone;
	private readonly body: Component;

	constructor(prompt: string, tone: CommandLogTone, body: Component) {
		this.prompt = prompt;
		this.tone = tone;
		this.body = body;
	}

	invalidate(): void {
		this.body.invalidate();
	}

	render(width: number): string[] {
		const bodyWidth = Math.max(1, width - 2);
		return [
			formatCommandLogHeader(this.prompt, this.tone),
			...this.body.render(bodyWidth).map((line) => `  ${truncateToWidth(line, bodyWidth, "", true)}`),
		];
	}
}

class ClankyCommandTextResultComponent implements Component {
	private readonly prompt: string;
	private readonly message: string;
	private readonly tone: CommandLogTone;

	constructor(prompt: string, message: string, tone: CommandLogTone) {
		this.prompt = prompt;
		this.message = message;
		this.tone = tone;
	}

	invalidate(): void {}

	render(width: number): string[] {
		const bodyWidth = Math.max(1, width - 2);
		const lines = [formatCommandLogHeader(this.prompt, this.tone)];
		for (const line of commandResultBodyLines(this.message)) {
			if (line.trim().length === 0) {
				lines.push("");
				continue;
			}
			for (const wrapped of wrapTextWithAnsi(styleCommandResultLine(line), bodyWidth)) {
				lines.push(`  ${truncateToWidth(wrapped, bodyWidth, "", true)}`);
			}
		}
		return lines;
	}
}

/**
 * Toggle the inline shell escape. In bash mode the editor border switches to the
 * accent color, the Clanky command typeahead is suppressed, and a submitted line
 * runs as a host shell command instead of a brain prompt. Pressing `!` on an
 * empty editor enters; Esc or backspace-on-empty exits. Mirrors the codex /
 * opencode `!` shell mode while staying on the public pi-tui Editor API.
 */
function setBashMode(on: boolean): void {
	if (bashMode === on) return;
	bashMode = on;
	editor.borderColor = on ? ansi.accent : ansi.dim;
	refreshCommandSurface(editor.getText());
	refreshStatusView();
	tui.requestRender();
}

function handleBashModeInput(data: string): { consume?: boolean; data?: string } | undefined {
	if (setupFlow.isWaitingForInput()) return undefined;
	if (!bashMode && matchesKey(data, "!") && editor.getText().length === 0) {
		setBashMode(true);
		return { consume: true };
	}
	if (bashMode && matchesKey(data, Key.escape)) {
		setBashMode(false);
		return { consume: true };
	}
	if (bashMode && matchesKey(data, Key.backspace) && editor.getText().length === 0) {
		setBashMode(false);
		return { consume: true };
	}
	return undefined;
}

async function handleBashPrompt(command: string): Promise<void> {
	const loader = new Loader(tui, ansi.accent, ansi.dim, `Running ${command}`, loaderIndicatorFor(agentSpinner));
	const loaderBlock = insertTranscript(loader, { collapsible: false, pin: "bottom" });
	loader.start();
	bashRunning += 1;
	refreshStatusView();
	tui.requestRender();
	try {
		const result = await runFaceBashCommand(command, {
			cwd: REPO,
			env: process.env,
			onSpawn: (child) => {
				activeBashChild = child;
			},
		});
		insertTranscript(new ClankyBashResultComponent(command, result, ansi));
		const ok = result.code === 0 && !result.timedOut;
		tuiLedger.record("!bash", `${command} -> ${result.timedOut ? "timed out" : `exit ${result.code}`}`, ok ? "success" : "error");
	} finally {
		activeBashChild = undefined;
		bashRunning = Math.max(0, bashRunning - 1);
		loader.stop();
		loaderBlock.remove();
		refreshStatusView();
		tui.requestRender();
	}
}

function formatCommandLogHeader(prompt: string, tone: CommandLogTone): string {
	const command = slashCommandLabel(prompt);
	const status = tone === "error" ? ansi.red("error") : ansi.green("done");
	return `${status} ${ansi.cyan(command)} ${ansi.dim("command")}`;
}

function slashCommandLabel(prompt: string): string {
	const token = prompt.trim().split(/\s+/u)[0];
	return token?.startsWith("/") === true ? token : "/command";
}

function commandResultBodyLines(message: string): string[] {
	const normalized = message.trim().replace(/\n{3,}/gu, "\n\n");
	if (normalized.length === 0) return [];
	return normalized.split(/\r?\n/u);
}

function styleCommandResultLine(line: string): string {
	if (line.trim().length === 0) return "";
	const heading = /^([A-Za-z][A-Za-z0-9 /_-]{0,30}:)(.*)$/u.exec(line);
	if (heading !== null) return `${ansi.yellow(heading[1] ?? "")}${heading[2] ?? ""}`;
	if (/^(Usage|Examples):$/u.test(line)) return ansi.dim(line);
	return line;
}

type StatusTone = "normal" | "active" | "ok" | "warn" | "bad" | "muted";

function statusTitle(text: string): string {
	return ansi.bold(ansi.cyan(text));
}

function statusSection(text: string): string {
	return ansi.cyan(text);
}

function statusLine(label: string, value: string, tone: StatusTone = "normal"): string {
	return `${ansi.dim(`${label}:`)} ${statusValue(value, tone)}`;
}

function statusInline(label: string, value: string, tone: StatusTone = "normal"): string {
	return `${ansi.dim(`${label} `)}${statusValue(value, tone)}`;
}

function statusValue(value: string, tone: StatusTone = "normal"): string {
	if (tone === "normal" && value.includes("\x1b[")) return value;
	switch (tone) {
		case "active":
			return ansi.bold(ansi.cyan(value));
		case "ok":
			return ansi.green(value);
		case "warn":
			return ansi.yellow(value);
		case "bad":
			return ansi.red(value);
		case "muted":
			return ansi.dim(value);
		case "normal":
			return ansi.bold(value);
	}
}

function statusPresence(present: boolean | undefined): string {
	return present === true ? statusValue("set", "ok") : statusValue("unset", "warn");
}

function statusOnOff(enabled: boolean): string {
	return enabled ? statusValue("on", "ok") : statusValue("off", "muted");
}

function statusAllowedBlocked(allowed: boolean): string {
	return allowed ? statusValue("allowed", "ok") : statusValue("blocked", "warn");
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
	// Inline shell escape: either bash mode is active or the line is `!`-prefixed
	// (typed fast or recalled from history). Runs locally in REPO, independent of
	// any in-flight brain turn, and stays in bash mode for the next command.
	if (bashMode || prompt.startsWith("!")) {
		const command = (prompt.startsWith("!") ? prompt.slice(1) : prompt).trim();
		if (command.length === 0) return;
		rememberPrompt(`!${command}`);
		await handleBashPrompt(command);
		return;
	}
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

function handleActiveTurnEscape(): boolean {
	const turn = activeTurn;
	if (turn === undefined || turn.controller.signal.aborted) return false;

	const canRestorePrompt = turn.promptRestoreEligible && editor.getText().trim().length === 0;
	if (canRestorePrompt) {
		turn.userBlock.remove?.();
		turn.loader.stop();
		turn.loaderBlock.remove();
		if (activeLoader === turn.loader) activeLoader = undefined;
		editor.setText(turn.prompt);
		tui.setFocus(editor);
		refreshCommandSurface(turn.prompt);
		refreshStatus("interrupted - edit prompt");
	} else {
		turn.loader.setMessage("Interrupting...");
		refreshStatus("interrupting");
	}
	turn.controller.abort();
	tui.requestRender();
	return true;
}

async function handleSlashPrompt(prompt: string): Promise<void> {
	const parsed = parsePromptCommand(prompt);
	if (typeof parsed === "string") {
		insertCommandResult(prompt, parsed, "error");
		return;
	}
	const outcome = await handleClankyCommand(parsed, commandRenderer);
	if (outcome.newSession === true && isResponding) {
		insertCommandResult(prompt, "Clanky is still responding; wait for the current turn to finish before starting a new session.", "error");
		return;
	}
	if (outcome.resumeSession !== undefined && isResponding) {
		insertCommandResult(prompt, "Clanky is still responding; wait for the current turn to finish before resuming another session.", "error");
		return;
	}
	if (outcome.clearTranscript === true) {
		transcriptViewport.clear();
		faceRenderer.resetTurn();
		tui.requestRender();
	}
	if (outcome.resumeSession !== undefined) {
		session = client.session(outcome.resumeSession);
		currentSessionLabel = outcome.resumeLabel;
		faceRenderer.resetSession();
	}
	if (outcome.message !== undefined && outcome.message.length > 0) {
		const tone: CommandLogTone = outcome.message.toLowerCase().includes("unknown ") ? "error" : "success";
		insertCommandResult(prompt, outcome.message, tone);
		tuiLedger.record(slashCommandLabel(prompt), outcome.message, tone);
	}
	if (outcome.component !== undefined) {
		const tone: CommandLogTone = outcome.ledgerMessage?.toLowerCase().includes("unknown ") === true ? "error" : "success";
		insertCommandComponent(prompt, outcome.component, tone);
		tuiLedger.record(slashCommandLabel(prompt), outcome.ledgerMessage ?? "rendered command output", tone);
	}
	if (outcome.newSession === true) {
		session = client.session();
		currentSessionLabel = undefined;
		faceRenderer.resetSession();
		if (shouldAnnounceNewSessionCommand(outcome)) {
			insertCommandResult(prompt, "New session started.", "success");
		}
	}
	if (outcome.exit === true) await shutdown(0);
}

async function runRemoteFaceCommand(request: FaceCommandRequest): Promise<void> {
	const commandLine = request.commandLine.trim();
	const sessionId = request.id;
	const command = slashCommandLabel(commandLine).replace(/^\//u, "");
	const emit = (event: ClankyMenuServerEvent): void => request.send(event);
	const flow = createRemoteSetupFlow(sessionId, command, request);
	const renderer: CommandRenderer = {
		setupFlow: flow,
		setConnectionAuthPendingCount(count: number): void {
			emit({ type: "menu.status", sessionId, text: count > 0 ? `${count} authorization ${count === 1 ? "request" : "requests"} pending` : undefined });
		},
		upsertConnectionAuth(state: ConnectionAuthState): void {
			const reason = state.reason === undefined ? "" : ` (${state.reason})`;
			emit({ type: "menu.line", sessionId, text: `Connection authorization ${state.state}: ${state.name}${reason}`, tone: state.state === "failed" ? "error" : "info" });
		},
	};

	emit({ type: "menu.begin", sessionId, command, title: commandLine });
	try {
		const parsed = parsePromptCommand(commandLine);
		if (typeof parsed === "string") {
			emit({ type: "menu.failed", sessionId, message: parsed });
			return;
		}
		const outcome = await handleClankyCommand(parsed, renderer);
		if (outcome.message !== undefined && outcome.message.length > 0) {
			emit({ type: "menu.line", sessionId, text: stripAnsi(outcome.message), tone: outcome.message.toLowerCase().includes("unknown ") ? "error" : "success" });
		}
		if (outcome.component !== undefined) {
			emit({ type: "menu.line", sessionId, text: renderCommandComponentText(outcome.component), tone: "success" });
		}
		if (outcome.newSession === true && shouldAnnounceNewSessionCommand(outcome)) {
			emit({ type: "menu.line", sessionId, text: "New session started.", tone: "success" });
		}
		if (outcome.clearTranscript === true) {
			emit({ type: "menu.line", sessionId, text: "Transcript cleared.", tone: "success" });
		}
		if (outcome.resumeSession !== undefined) {
			session = client.session(outcome.resumeSession);
			currentSessionLabel = outcome.resumeLabel;
			faceRenderer.resetSession();
		}
		if (outcome.newSession === true) {
			session = client.session();
			currentSessionLabel = undefined;
			faceRenderer.resetSession();
		}
		if (outcome.exit === true) {
			emit({ type: "menu.failed", sessionId, message: "/exit is only available in the attached TUI face." });
			return;
		}
		emit({ type: "menu.end", sessionId, message: "Done." });
	} catch (error) {
		emit({ type: "menu.failed", sessionId, message: formatError(error) });
	}
}

function createRemoteSetupFlow(sessionId: string, command: string, request: FaceCommandRequest): SetupFlow {
	let stepIndex = 0;
	const interruptResolvers = new Set<() => void>();

	const nextStepId = (): string => `step-${++stepIndex}`;
	const waitForStep = async (stepId: string): Promise<ClankyMenuClientMessage | undefined> => {
		for (;;) {
			const message = await request.waitForClientMessage();
			if (message === undefined) return undefined;
			if (message.type === "menu.cancel") {
				for (const resolve of interruptResolvers) resolve();
				interruptResolvers.clear();
				return undefined;
			}
			if (message.stepId === stepId) return message;
		}
	};

	return {
		begin(title: string): void {
			request.send({ type: "menu.begin", sessionId, command, title });
		},
		end(): void {
			request.send({ type: "menu.status", sessionId, text: undefined });
		},
		renderOutput(text: string): void {
			request.send({ type: "menu.line", sessionId, text: stripAnsi(text), tone: "info" });
		},
		renderLine(text: string, tone: FlowLineTone = "info"): void {
			request.send({ type: "menu.line", sessionId, text: stripAnsi(text), tone });
		},
		setStatus(statusText: string | undefined): void {
			request.send({ type: "menu.status", sessionId, text: statusText });
		},
		async readText(options): Promise<string | undefined> {
			const stepId = nextStepId();
			request.send({
				type: "menu.text",
				sessionId,
				stepId,
				message: options.message,
				...(options.placeholder === undefined ? {} : { placeholder: options.placeholder }),
				...(options.defaultValue === undefined ? {} : { defaultValue: options.defaultValue }),
				...(options.allowBack === undefined ? {} : { allowBack: options.allowBack }),
			});
			const message = await waitForStep(stepId);
			return message?.type === "menu.respond" ? message.text : undefined;
		},
		async readSelect(options): Promise<string[] | undefined> {
			const stepId = nextStepId();
			request.send({
				type: "menu.select",
				sessionId,
				stepId,
				message: options.message,
				kind: options.kind,
				options: options.options.map(toRemoteMenuOption),
				...(options.statusActions === undefined ? {} : { statusActions: options.statusActions.map(toRemoteMenuOption) }),
				...(options.currentValues === undefined && options.currentValue === undefined ? {} : { currentValues: options.currentValues ?? (options.currentValue === undefined ? [] : [options.currentValue]) }),
				...(options.required === undefined ? {} : { required: options.required }),
				...(options.allowBack === undefined ? {} : { allowBack: options.allowBack }),
			});
			const message = await waitForStep(stepId);
			return message?.type === "menu.respond" ? [...(message.values ?? [])] : undefined;
		},
		waitForInterrupt() {
			let resolver: (() => void) | undefined;
			const promise = new Promise<void>((resolve) => {
				resolver = resolve;
				interruptResolvers.add(resolve);
			});
			return {
				promise,
				dispose(): void {
					if (resolver !== undefined) interruptResolvers.delete(resolver);
				},
			};
		},
	};
}

function toRemoteMenuOption(option: MenuOption): { value: string; label: string; hint?: string; description?: string } {
	return {
		value: option.value,
		label: option.label,
		...(option.hint === undefined ? {} : { hint: option.hint }),
		...(option.description === undefined ? {} : { description: option.description }),
	};
}

function renderCommandComponentText(component: Component): string {
	try {
		return stripAnsi(component.render(100).join("\n"));
	} catch (error) {
		return `Rendered command output is unavailable: ${formatError(error)}`;
	}
}

function stripAnsi(text: string): string {
	return text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/gu, "");
}

async function submitPrompt(prompt: string): Promise<void> {
	faceRenderer.resetTurn();
	isResponding = true;
	const controller = new AbortController();
	const userBlock = insertMarkdown(`**You**\n\n${prompt}`);
	const loader = new Loader(tui, ansi.cyan, ansi.dim, "Thinking...", loaderIndicatorFor(agentSpinner));
	activeLoader = loader;
	const loaderBlock = insertTranscript(loader, { collapsible: false, pin: "bottom" });
	const turn: ActivePromptTurn = {
		controller,
		loader,
		loaderBlock,
		prompt,
		promptRestoreEligible: true,
		userBlock,
	};
	activeTurn = turn;
	loader.start();
	refreshStatus("streaming");
	tui.requestRender();

	try {
		const clientContext = await buildTuiClientContext();
		const sendInput: SendTurnInput =
			clientContext === undefined
				? { message: prompt, signal: controller.signal }
				: { message: prompt, clientContext, signal: controller.signal };
		const persistence = {
			label: summarizeSessionPrompt(prompt),
			lastPrompt: prompt,
		};
		if (currentSessionLabel === undefined) currentSessionLabel = persistence.label;
		await consumeTurn(session.send(sendInput), turn, persistence);
		if (!controller.signal.aborted) {
			const notice = faceRenderer.noticeForCompletedTurn(turnTraceMode);
			if (notice !== undefined) insertMarkdown(`**Notice**\n\n${notice}`);
		}
	} catch (error) {
		if (!controller.signal.aborted || !isAbortError(error)) {
			insertMarkdown(`**Error**\n\n${formatError(error)}`);
		}
	} finally {
		loader.stop();
		loaderBlock.remove();
		if (activeLoader === loader) activeLoader = undefined;
		if (activeTurn === turn) activeTurn = undefined;
		isResponding = false;
		refreshStatus("ready");
		tui.requestRender();
	}
}

/**
 * The TUI state the brain should see for the next turn: recent face-side
 * commands plus the live worker roster (fetched only after a face spawn, so
 * idle chats add no latency). Attached as ephemeral eve `clientContext`.
 */
async function buildTuiClientContext(): Promise<string | undefined> {
	const actions = tuiLedger.actionLines();
	let workers: string[] = [];
	if (tuiLedger.hasSpawnActivity() && process.env.HERDR_ENV === "1") {
		try {
			const agents = await listHerdrAgents();
			// herdr can report one pane under multiple sources; keep one row each.
			const deduped = [...new Map(agents.map((agent) => [agent.paneId, agent])).values()];
			workers = formatWorkerRosterForBrain(deduped.filter((agent) => agent.agent.startsWith("clanky:")));
		} catch {
			// Roster unavailable (herdr down / off-stage); fall back to the action ledger alone.
		}
	}
	return buildTuiContextMessage({ actions, workers });
}

function restoreContinuationFromResponse(
	response: Awaited<ReturnType<ClientSession["send"]>>,
	observedEvents: number,
): void {
	const state = session.state;
	if (state.continuationToken !== undefined || response.continuationToken === undefined) return;
	session = client.session({
		...state,
		continuationToken: response.continuationToken,
		sessionId: state.sessionId ?? response.sessionId,
		streamIndex: state.streamIndex > 0 ? state.streamIndex : observedEvents,
	});
}

async function persistCurrentFaceSession(persistence: FaceSessionPersistence | undefined): Promise<void> {
	try {
		await rememberTuiSession(
			FACE_SESSION_STORE_PATH,
			{
				label: persistence?.label ?? currentSessionLabel,
				lastPrompt: persistence?.lastPrompt,
				session: session.state,
			},
			{ limit: FACE_SESSION_STORE_LIMIT, maxAgeMs: FACE_SESSION_MAX_AGE_MS },
		);
	} catch (error) {
		console.error("failed to persist Clanky face session:", error);
	}
}

function summarizeSessionPrompt(prompt: string): string {
	const firstLine = prompt.trim().split(/\r?\n/u)[0]?.trim() ?? "";
	const normalized = firstLine.replace(/\s+/gu, " ");
	if (normalized.length <= 80) return normalized.length === 0 ? "Untitled session" : normalized;
	return `${normalized.slice(0, 77)}...`;
}

async function consumeTurn(
	responsePromise: Promise<Awaited<ReturnType<ClientSession["send"]>>>,
	turn?: ActivePromptTurn,
	persistence?: FaceSessionPersistence,
): Promise<void> {
	const pendingInputRequests = new InputRequestQueue();
	const response = await responsePromise;
	let observedEvents = 0;
	let sessionFailed = false;
	for await (const event of response) {
		observedEvents += 1;
		if (event.type === "session.failed") sessionFailed = true;
		if (turn?.controller.signal.aborted === true) break;
		if (turn !== undefined && eventPreventsPromptRestore(event)) turn.promptRestoreEligible = false;
		const result = faceRenderer.renderEvent(event);
		if (result.inputRequests.length > 0) pendingInputRequests.add(result.inputRequests);
		refreshStatus(statusLabelForFaceEvent(event));
		tui.requestRender();
	}
	if (turn?.controller.signal.aborted === true) return;
	if (!sessionFailed) restoreContinuationFromResponse(response, observedEvents);
	await persistCurrentFaceSession(persistence);
	const requests = pendingInputRequests.drain();
	if (requests.length === 0) return;
	const inputResponses = await readInputResponses(requests);
	if (inputResponses.length === 0) return;
	faceRenderer.recordInputResponses(inputResponses);
	const followUpInput: SendTurnInput = turn === undefined
		? { inputResponses }
		: { inputResponses, signal: turn.controller.signal };
	await consumeTurn(session.send(followUpInput), turn, persistence);
}

function eventPreventsPromptRestore(event: HandleMessageStreamEvent): boolean {
	switch (event.type) {
		case "message.appended":
			return event.data.messageDelta.trim().length > 0 || event.data.messageSoFar.trim().length > 0;
		case "message.completed":
			return (event.data.message ?? "").trim().length > 0;
		case "reasoning.appended":
			return event.data.reasoningDelta.trim().length > 0 || event.data.reasoningSoFar.trim().length > 0;
		case "reasoning.completed":
			return (event.data.reasoning ?? "").trim().length > 0;
		case "actions.requested":
			return event.data.actions.length > 0;
		case "input.requested":
			return event.data.requests.length > 0;
		case "action.result":
		case "authorization.completed":
		case "authorization.required":
		case "compaction.completed":
		case "compaction.requested":
		case "result.completed":
		case "session.failed":
		case "step.failed":
		case "subagent.called":
		case "subagent.completed":
		case "subagent.event":
		case "subagent.started":
		case "turn.failed":
			return true;
		default:
			return false;
	}
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
			return clankyNewSessionCommandOutcome({ quiet: command.quiet === true });
		case "resume":
			return await resumeSessionCommandOutcome(command.argument, renderer.setupFlow);
		case "clear":
			return { clearTranscript: true };
		case "exit":
			return { exit: true };
		case "extension":
			return await handleExtensionCommand(command, renderer);
	}
	return { message: "Unknown command." };
}

async function resumeSessionCommandOutcome(argument: string, flow: SetupFlow | undefined): Promise<PromptCommandOutcome> {
	const selector = argument.trim();
	let entries: readonly TuiSessionEntry[];
	try {
		entries = [...(await readTuiSessionStore(FACE_SESSION_STORE_PATH, { maxAgeMs: FACE_SESSION_MAX_AGE_MS })).entries]
			.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
	} catch (error) {
		return { message: `Could not read saved Clanky sessions: ${formatError(error)}` };
	}
	if (entries.length === 0) return { message: "No saved Clanky sessions yet." };
	if (isResumeListSelector(selector)) return { message: formatResumeSessionList(entries) };

	if (selector.length === 0) {
		if (flow === undefined) return { message: formatResumeSessionList(entries) };
		const selected = await selectResumeSession(flow, entries);
		return selected === undefined ? { message: "/resume cancelled." } : resumeSessionOutcomeForEntry(selected);
	}

	const selected = findResumeSessionEntry(entries, selector);
	return typeof selected === "string" ? { message: selected } : resumeSessionOutcomeForEntry(selected);
}

async function selectResumeSession(flow: SetupFlow, entries: readonly TuiSessionEntry[]): Promise<TuiSessionEntry | undefined> {
	flow.begin("Resume Clanky session");
	try {
		const selected = await flow.readSelect({
			kind: "single",
			message: "Pick a saved Clanky session to resume.",
			options: entries.map(resumeSessionOption),
			initialValue: entries[0]?.id,
			required: true,
			allowBack: true,
		});
		const id = selected?.[0];
		return id === undefined ? undefined : entries.find((entry) => entry.id === id);
	} finally {
		flow.end({ preserveDiagnostics: false });
	}
}

function resumeSessionOutcomeForEntry(entry: TuiSessionEntry): PromptCommandOutcome {
	const label = resumeSessionLabel(entry);
	return {
		resumeLabel: label,
		resumeSession: entry.session,
		message: `Resumed Clanky session ${shortSessionId(entry.id)} (${label}).`,
	};
}

function isResumeListSelector(selector: string): boolean {
	return /^(list|ls|show|status)$/iu.test(selector);
}

function findResumeSessionEntry(entries: readonly TuiSessionEntry[], selector: string): TuiSessionEntry | string {
	if (/^\d+$/u.test(selector)) {
		const index = Number(selector) - 1;
		return entries[index] ?? `No saved Clanky session #${selector}. Use /resume list to see saved sessions.`;
	}
	const normalized = selector.toLowerCase();
	const matches = entries.filter((entry) => resumeSessionSelectors(entry).some((candidate) => candidate.toLowerCase().startsWith(normalized)));
	if (matches.length === 1) return matches[0]!;
	if (matches.length > 1) {
		const choices = matches.slice(0, 5).map((entry) => shortSessionId(entry.id)).join(", ");
		const suffix = matches.length > 5 ? ", ..." : "";
		return `Session selector "${selector}" is ambiguous: ${choices}${suffix}.`;
	}
	return `No saved Clanky session matches "${selector}". Use /resume list to see saved sessions.`;
}

function resumeSessionSelectors(entry: TuiSessionEntry): readonly string[] {
	return [entry.id, entry.session.sessionId, entry.session.continuationToken].filter((value): value is string => value !== undefined && value.length > 0);
}

function resumeSessionOption(entry: TuiSessionEntry): MenuOption {
	return {
		value: entry.id,
		label: resumeSessionLabel(entry),
		description: `${formatResumeSessionTimestamp(entry.updatedAt)} - ${shortSessionId(entry.id)}`,
		hint: entry.lastPrompt === undefined ? undefined : truncateToWidth(entry.lastPrompt, 72, "..."),
	};
}

function formatResumeSessionList(entries: readonly TuiSessionEntry[]): string {
	return [
		statusTitle("Saved Clanky sessions"),
		"",
		...entries.map((entry, index) => {
			const label = ansi.bold(resumeSessionLabel(entry));
			const meta = ansi.dim(`${formatResumeSessionTimestamp(entry.updatedAt)} - ${shortSessionId(entry.id)}`);
			const prompt = entry.lastPrompt === undefined ? "" : `\n   ${ansi.dim(truncateToWidth(entry.lastPrompt, 96, "..."))}`;
			return `${ansi.dim(`${index + 1}.`)} ${label} ${meta}${prompt}`;
		}),
		"",
		ansi.dim("Use /resume <number> or /resume <session-id-prefix>."),
	].join("\n");
}

function resumeSessionLabel(entry: TuiSessionEntry): string {
	const label = entry.label?.trim();
	if (label !== undefined && label.length > 0) return label;
	return "Untitled session";
}

function shortSessionId(id: string): string {
	return id.length <= 12 ? id : `${id.slice(0, 8)}...${id.slice(-4)}`;
}

function formatResumeSessionTimestamp(value: string): string {
	const date = new Date(value);
	if (!Number.isFinite(date.getTime())) return value;
	return date.toLocaleString(undefined, {
		day: "numeric",
		hour: "numeric",
		minute: "2-digit",
		month: "short",
	});
}

async function handleExtensionCommand(command: ClankyExtensionCommand, renderer: CommandRenderer): Promise<PromptCommandOutcome> {
	switch (command.name) {
		case "discord-token":
			return { message: (await setDiscordToken(command.argument, renderer.setupFlow)) ?? "/discord-token cancelled." };
		case "discord-scope":
			return { message: await configureDiscordScope(command.argument, renderer.setupFlow) };
		case "auth":
			return { message: await configureAuth(command.argument, renderer.setupFlow, renderer) };
		case "login":
			return { message: await configureLogin(command.argument, renderer.setupFlow) };
		case "model":
			return { message: await configureModel(command.argument, renderer.setupFlow) };
		case "profile":
			return { message: await configureProfile(command.argument, renderer.setupFlow) };
		case "harness":
			return { message: await configureHarness(command.argument, renderer.setupFlow) };
		case "effort":
			return { message: await configureEffort(command.argument, renderer.setupFlow) };
		case "approvals":
			return { message: await configureApprovals(command.argument, renderer.setupFlow) };
		case "agent-md":
			return { message: await configureAgentMd(command.argument, renderer.setupFlow) };
		case "skills":
			return await skillsOutcome();
		case "image-model":
			return { message: await configureImageModel(command.argument, renderer.setupFlow) };
		case "video-model":
			return { message: await configureVideoModel(command.argument, renderer.setupFlow) };
		case "vision-model":
			return { message: await configureVisionModel(command.argument, renderer.setupFlow) };
		case "pet":
			return { message: await configurePet(command.argument, renderer.setupFlow) };
		case "voice":
			return { message: await configureVoice(command.argument, renderer.setupFlow) };
		case "push":
			return { message: await configurePush(command.argument, renderer.setupFlow) };
		case "integrations":
			return { message: await configureIntegrations(command.argument, renderer.setupFlow) };
		case "mcp":
			return { message: await configureMcp(command.argument, renderer.setupFlow, renderer) };
		case "browser":
			return { message: await configureBrowserBridge(command.argument, renderer.setupFlow) };
		case "trace":
			return { message: await configureTrace(command.argument, renderer.setupFlow) };
		case "layout":
			return { message: await configureLayout(command.argument, renderer.setupFlow) };
		case "agents":
			return { message: await configureAgents(command.argument, renderer.setupFlow) };
		case "spawn":
			return { message: await spawnWorkerFromFace(command.argument, renderer.setupFlow) };
		case "pair":
			return { message: await configurePairing(command.argument) };
		case "status":
			return { message: await statusText() };
	}
}

function formatHelp(): string {
	const bullet = ansi.dim("-");
	return [
		"Available commands:",
		"",
		...COMMANDS.map((command) => {
			const name = ansi.bold(ansi.cyan(`/${command.name}`));
			const hint = command.argumentHint === undefined ? "" : ` ${ansi.dim(command.argumentHint)}`;
			const aliases =
				command.aliases.length === 0 ? "" : ` ${ansi.dim(`(${command.aliases.map((alias) => `/${alias}`).join(", ")})`)}`;
			return `${bullet} ${name}${hint}${aliases} ${ansi.dim("·")} ${command.description}`;
		}),
	].join("\n");
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
	fields.server = brainHost.replace(/^https?:\/\//u, "");
	const stage = bannerStage();
	fields.stage = stage.value;
	fields.stageLabel = stage.label;
	return fields;
}

/**
 * Which terminal multiplexer this face sits in, and where: the session that
 * worker spawns share plus this face's own pane (copy-pasteable for
 * `herdr pane read` / `tmux capture-pane -t`). herdr takes precedence over tmux
 * since Clanky's stage is herdr-native and herdr can itself run under tmux. When
 * no multiplexer is detected we report `stage none` rather than dropping the row,
 * so the header always says where spawns would (or wouldn't) land.
 */
function bannerStage(): { label: string; value: string } {
	return bannerHerdrStage() ?? bannerTmuxStage() ?? { label: "stage", value: "none" };
}

function bannerHerdrStage(): { label: string; value: string } | undefined {
	if (process.env.HERDR_ENV !== "1") return undefined;
	const workspaceName = herdrWorkspaceName(process.env.HERDR_WORKSPACE_ID ?? process.env.CLANKY_FACE_HERDR_WORKSPACE_ID);
	return { label: "herdr", value: herdrStageValue(herdrSessionName(), workspaceName, process.env.HERDR_PANE_ID) };
}

function bannerTmuxStage(): { label: string; value: string } | undefined {
	if (process.env.TMUX === undefined || process.env.TMUX.length === 0) return undefined;
	return { label: "tmux", value: stageValue(tmuxSessionName(), process.env.TMUX_PANE) };
}

/** A `{session} · pane {pane}` summary, or "none" when neither is known. */
function stageValue(session: string | undefined, pane: string | undefined): string {
	const parts: string[] = [];
	const sessionName = session?.trim();
	const paneId = pane?.trim();
	if (sessionName !== undefined && sessionName.length > 0) parts.push(sessionName);
	if (paneId !== undefined && paneId.length > 0) parts.push(`pane ${paneId}`);
	return parts.length > 0 ? parts.join(" · ") : "none";
}

function herdrStageValue(session: string, workspace: string | undefined, pane: string | undefined): string {
	const parts = [session];
	const workspaceName = workspace?.trim();
	const paneId = pane?.trim();
	if (workspaceName !== undefined && workspaceName.length > 0) parts.push(workspaceName);
	if (paneId !== undefined && paneId.length > 0) parts.push(paneId);
	return parts.join(" · ");
}

function herdrSessionName(): string {
	const envSession = process.env.HERDR_SESSION?.trim();
	if (envSession !== undefined && envSession.length > 0) return envSession;
	if (herdrSessionNameCache !== undefined) return herdrSessionNameCache;
	const socketPath = process.env.HERDR_SOCKET_PATH?.trim();
	try {
		const output = execFileSync("herdr", ["session", "list", "--json"], {
			encoding: "utf8",
			timeout: 1000,
			stdio: ["ignore", "pipe", "ignore"],
		});
		herdrSessionNameCache = parseHerdrSessionName(JSON.parse(output) as unknown, socketPath) ?? "default";
	} catch {
		herdrSessionNameCache = "default";
	}
	return herdrSessionNameCache;
}

function parseHerdrSessionName(payload: unknown, socketPath: string | undefined): string | undefined {
	if (!isRecord(payload) || !Array.isArray(payload.sessions)) return undefined;
	const sessions = payload.sessions.filter(isRecord);
	const matched =
		socketPath === undefined
			? sessions.find((session) => session.running === true && session.default === true) ??
				sessions.find((session) => session.running === true)
			: sessions.find((session) => session.socket_path === socketPath) ??
				sessions.find((session) => session.running === true && session.default === true);
	const name = typeof matched?.name === "string" ? matched.name.trim() : "";
	return name.length > 0 ? name : undefined;
}

function herdrWorkspaceName(workspaceId: string | undefined): string | undefined {
	if (herdrWorkspaceNameCache !== undefined) return herdrWorkspaceNameCache ?? undefined;
	const trimmedWorkspaceId = workspaceId?.trim();
	try {
		const output = execFileSync("herdr", ["workspace", "list"], {
			encoding: "utf8",
			timeout: 1000,
			stdio: ["ignore", "pipe", "ignore"],
		});
		herdrWorkspaceNameCache = parseHerdrWorkspaceName(JSON.parse(output) as unknown, trimmedWorkspaceId) ?? trimmedWorkspaceId ?? null;
	} catch {
		herdrWorkspaceNameCache = trimmedWorkspaceId ?? null;
	}
	return herdrWorkspaceNameCache ?? undefined;
}

function parseHerdrWorkspaceName(payload: unknown, workspaceId: string | undefined): string | undefined {
	if (!isRecord(payload) || !isRecord(payload.result) || !Array.isArray(payload.result.workspaces)) return undefined;
	const workspaces = payload.result.workspaces.filter(isRecord);
	const matched =
		workspaceId === undefined
			? workspaces.find((workspace) => workspace.focused === true)
			: workspaces.find((workspace) => workspace.workspace_id === workspaceId) ??
				workspaces.find((workspace) => workspace.focused === true);
	const label = typeof matched?.label === "string" ? matched.label.trim() : "";
	return label.length > 0 ? label : undefined;
}

/** tmux exposes the pane via `TMUX_PANE` but not the session name; ask tmux. */
function tmuxSessionName(): string | undefined {
	try {
		const name = execFileSync("tmux", ["display-message", "-p", "#S"], {
			encoding: "utf8",
			timeout: 1000,
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
		return name.length > 0 ? name : undefined;
	} catch {
		return undefined;
	}
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
	if (!uiReady) return;
	status.setText(formatStatusText(currentStatusLabel));
	tui.requestRender();
}

function currentAgentSpinnerFrame(): string {
	const index = Math.floor(Date.now() / agentSpinner.intervalMs) % agentSpinner.frames.length;
	return agentSpinner.frames[index] ?? "";
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
	const disabled = setupFlow.isWaitingForInput() || bashMode;
	commandTypeaheadState = disabled ? undefined : clankyCommandTypeaheadFor(COMMANDS, text, commandTypeaheadState);
	commandTypeaheadPanel.setText(text, commandTypeaheadState, disabled);
	tui.requestRender();
}

function formatStatusText(label: string): string {
	const model = bannerModelId(latestInfo) ?? "model unknown";
	const responseState = isResponding && label !== "ready" && label !== "streaming" ? "responding" : "";
	const setupState = setupFlow.isWaitingForInput() ? "setup input" : "";
	const authState = connectionAuthPendingCount > 0 ? `auth pending ${connectionAuthPendingCount}` : "";
	const focusState = transcriptViewport.focused ? "transcript nav" : "";
	const bashState = bashMode
		? `${ansi.accent("shell")}${bashRunning > 0 ? ansi.dim(" running") : ansi.dim(` · ${displayHomePath(REPO)}`)}`
		: "";
	const brainState = formatBrainHealthStatus(brainHealth);
	const parts = [
		formatPrimaryStatusLabel(label),
		...(responseState.length === 0 ? [] : [ansi.dim(responseState)]),
		setupState,
		authState,
		focusState,
		bashState,
		model,
		formatContextUsage(faceRenderer.lastUsage, currentContextSize),
	]
		.filter((part) => part.length > 0)
		.map((part) => part.includes("\x1b[") ? part : ansi.dim(part));
	const showStatusBrand = !headerVisible;
	if (showStatusBrand) parts.unshift(formatStatusBrand());
	if (brainState.length > 0) parts.splice(showStatusBrand ? 2 : 1, 0, brainState);
	const statusLine = parts.join("  ·  ");
	if (layoutSettings.inputPlacement === "bottom" && layoutSettings.statusPlacement === "above-input") return `\n${statusLine}`;
	if (layoutSettings.inputPlacement === "top" && layoutSettings.statusPlacement === "below-input") return `${statusLine}\n`;
	return statusLine;
}

function formatPrimaryStatusLabel(label: string): string {
	return ansi.dim(label);
}

function formatStatusBrand(): string {
	return ansi.bold(ansi.accent("clanky"));
}

function formatSingleStatusRow(text: string, width: number): string {
	const safeWidth = Math.max(1, width);
	const paddingX = safeWidth > 2 ? 1 : 0;
	const contentWidth = Math.max(1, safeWidth - paddingX * 2);
	const content = truncateToWidth(text, contentWidth, "", true);
	const row = `${" ".repeat(paddingX)}${content}${" ".repeat(paddingX)}`;
	return `${row}${" ".repeat(Math.max(0, safeWidth - visibleWidth(row)))}`;
}

// Wrap the status bar across rows so long transient messages (e.g. a modal's
// auth result, surfaced via flow.renderOutput) stay fully readable instead of
// being clipped to a single width-truncated line. Short status lines still
// render as one row. Capped so a pathological message can't eat the screen.
function formatStatusRows(text: string, width: number): string[] {
	const safeWidth = Math.max(1, width);
	const paddingX = safeWidth > 2 ? 1 : 0;
	const contentWidth = Math.max(1, safeWidth - paddingX * 2);
	const rows: string[] = [];
	for (const line of text.split(/\r?\n/u)) {
		if (line.trim().length === 0) {
			rows.push("");
			continue;
		}
		rows.push(...wrapTextWithAnsi(line, contentWidth));
	}
	if (rows.length === 0) rows.push("");
	const limited =
		rows.length > STATUS_BAR_MAX_ROWS
			? [...rows.slice(0, STATUS_BAR_MAX_ROWS - 1), `${truncateToWidth(rows[STATUS_BAR_MAX_ROWS - 1] ?? "", Math.max(1, contentWidth - 1), "", true)}…`]
			: rows;
	return limited.map((row) => formatSingleStatusRow(row, width));
}

function formatBrainHealthStatus(health: BrainHealthState): string {
	switch (health.state) {
		case "healthy":
			return "";
		case "unknown":
			return ansi.dim("eve status unknown");
		case "restarting":
			return ansi.yellow("eve restarting");
		case "unhealthy":
			return ansi.yellow(`eve unavailable ${health.status}`);
		case "down":
			return ansi.red("eve unreachable");
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

async function shutdown(exitCode: number, options: ShutdownOptions = {}): Promise<void> {
	if (shutdownStarted) process.exit(exitCode);
	shutdownStarted = true;
	try {
		if (options.abortTurn === true) activeTurn?.controller.abort();
		if (options.waitForTurn !== false && runningTurn !== undefined) await runningTurn.catch(() => undefined);
		stopBrainHealthMonitor();
		stopFacePresence();
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

async function setDiscordToken(
	argument: string,
	flow: SetupFlow | undefined,
	options: MenuBackOptions = {},
): Promise<string | undefined> {
	const args = splitArgs(argument);
	const config = await readConfig();
	const first = args[0]?.toLowerCase();
	if (first === "status" || first === "show") return formatDiscordCredentialStatus(config);
	const token = args.find((arg) => !arg.startsWith("--"));
	if (token === undefined) {
		if (flow === undefined) return `${formatDiscordCredentialStatus(config)}\n\nUsage: /discord-token [status|<token>] [--user-token] [--voice]`;
		const update = await promptDiscordToken(flow, config);
		if (update === undefined) return options.backReturnsToMenu === true ? undefined : "/discord-token cancelled.";
		if (typeof update === "string") return update;
		await writeEnv(update.updates);
		return await restartBrainMessage(update.message);
	}

	const update = buildDiscordTokenUpdate(token, args.includes("--user-token") ? "user-token" : "bot-token", args.includes("--voice"));
	await writeEnv(update.updates);
	return await restartBrainMessage(update.message);
}

async function promptDiscordToken(flow: SetupFlow, config: ClankyConfig): Promise<DiscordTokenUpdate | string | undefined> {
	flow.begin("Set Discord credential");
	try {
		flow.renderOutput(formatDiscordCredentialStatus(config));
		// action -> kind -> voice -> token wizard. Left/Esc steps back one stage;
		// backing out of the action step cancels.
		let step: "action" | "kind" | "voice" | "token" = "action";
		let kind: "bot-token" | "user-token" = "bot-token";
		let voice = false;
		for (;;) {
			if (step === "action") {
				const action = await selectOne(flow, "Choose the Discord credential action.", DISCORD_TOKEN_ACTION_OPTIONS, "status", true);
				if (action === "status") return formatDiscordCredentialStatus(config);
				if (action !== "set") return undefined;
				step = "kind";
				continue;
			}
			if (step === "kind") {
				const chosen = await selectOne(flow, "Choose the Discord credential kind.", DISCORD_CREDENTIAL_KIND_OPTIONS, kind, true);
				if (chosen === undefined) {
					step = "action";
					continue;
				}
				if (chosen !== "bot-token" && chosen !== "user-token") return undefined;
				kind = chosen;
				step = "voice";
				continue;
			}
			if (step === "voice") {
				const voiceValue = await selectOne(flow, "Enable Discord voice with this credential?", DISCORD_TOKEN_VOICE_OPTIONS, voice ? "on" : "off", true);
				if (voiceValue === undefined) {
					step = "kind";
					continue;
				}
				const parsed = parseOnOff(voiceValue);
				if (parsed === undefined) return undefined;
				voice = parsed;
				step = "token";
				continue;
			}
			const token = await flow.readText({
				message: "Paste the Discord credential.",
				placeholder: kind === "user-token" ? "Discord user token" : "Discord bot token",
				allowBack: true,
				validate: requiredDiscordTokenText,
			});
			if (token === undefined) {
				step = "voice";
				continue;
			}
			return buildDiscordTokenUpdate(token, kind, voice);
		}
	} finally {
		flow.end({ preserveDiagnostics: false });
	}
}

function formatDiscordCredentialStatus(config: ClankyConfig): string {
	const tokenState = config.discordTokenPresent === true ? "set" : "unset";
	const credentialKind = config.discordCredentialKind === "user-token" ? "user-token" : "bot-token";
	const voiceEnabled = parseVoiceToggle(config.discordVoice) === true;
	return [
		statusTitle("Discord credential"),
		statusLine("token", tokenState, config.discordTokenPresent === true ? "ok" : "warn"),
		statusLine("kind", credentialKind),
		statusLine("voice runtime", voiceEnabled ? "on" : "off", voiceEnabled ? "ok" : "muted"),
	].join("\n");
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
	const apply = async (update: DiscordScopeUpdate | string | undefined): Promise<string | undefined> => {
		if (update === undefined) return undefined;
		if (typeof update === "string") return update;
		return await saveDiscordScopeUpdate(update);
	};
	const runTargetMenu = async (target: DiscordScopeTarget): Promise<string | undefined> =>
		await settingsLoop(flow, {
			title: target === "guilds" ? "Choose a server allowlist action." : "Choose a channel allowlist action.",
			options: () => DISCORD_SCOPE_TARGET_ACTION_OPTIONS,
			initial: "set",
			dispatch: async (verb) => {
				switch (verb) {
					case "set":
						return await apply(await promptDiscordScopeReplace(flow, config, target));
					case "add":
						return await apply(await promptDiscordScopeAdd(flow, config, target));
					case "remove":
						return await apply(await promptDiscordScopeRemove(flow, config, target));
					default:
						return undefined;
				}
			},
		});
	flow.begin("Configure Discord reply scope");
	try {
		const result = await settingsLoop(flow, {
			title: "Choose what to change.",
			options: () => DISCORD_SCOPE_GROUP_OPTIONS,
			renderStatus: () => formatDiscordScopeMenuStatus(config),
			dispatch: async (action) => {
				switch (action) {
					case "group:guilds":
						return await runTargetMenu("guilds");
					case "group:channels":
						return await runTargetMenu("channels");
					case "dms":
						return await apply(await promptDiscordScopeDms(flow, config));
					case "clear":
						return await apply(await promptDiscordScopeClear(flow));
					default:
						return undefined;
				}
			},
		});
		return result ?? "/discord-scope cancelled.";
	} finally {
		flow.end({ preserveDiagnostics: false });
	}
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
		allowBack: true,
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
		allowBack: true,
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
		allowBack: true,
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
		true,
	);
	const enabled = parseOnOff(selected);
	return enabled === undefined ? undefined : buildDiscordScopeDmsUpdate(enabled);
}

async function promptDiscordScopeClear(flow: SetupFlow): Promise<DiscordScopeUpdate | undefined> {
	const target = await selectOne(flow, "Choose Discord scope settings to clear.", DISCORD_SCOPE_CLEAR_OPTIONS, "all", true);
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
		statusTitle("Discord reply scope"),
		statusLine("guilds", formatDiscordScopeList(config.discordAllowedGuildIds, "any server the token can see")),
		statusLine("channels", formatDiscordScopeList(config.discordAllowedChannelIds, "any channel in allowed servers")),
		statusLine("DMs", configBooleanDefaultTrue(config.discordAllowDms) ? "allowed" : "blocked", configBooleanDefaultTrue(config.discordAllowDms) ? "ok" : "warn"),
	].join("\n");
}

function formatDiscordScopeMenuStatus(config: ClankyConfig): SettingsMenuStatus {
	const collapsed = `${statusTitle("Discord scope")}\n${formatDiscordScopeSummary(config)}`;
	return discordScopeConfiguredIdCount(config) > 2 ? collapsibleMenuStatus(collapsed, formatDiscordScopeConfig(config)) : collapsed;
}

function discordScopeConfiguredIdCount(config: ClankyConfig): number {
	return parseMcpStringList(config.discordAllowedGuildIds).length + parseMcpStringList(config.discordAllowedChannelIds).length;
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

type PushConfigField = "key-path" | "key-id" | "team-id" | "bundle-id" | "env";
type PushConfigUpdate = {
	updates: Record<string, string>;
	removals: readonly string[];
	message: string;
};

async function configurePush(argument: string, flow: SetupFlow | undefined): Promise<string> {
	let args: string[];
	try {
		args = splitCommandLine(argument);
	} catch (error) {
		return `Invalid /push command: ${error instanceof Error ? error.message : String(error)}`;
	}
	const command = args[0];
	const normalized = command === undefined ? undefined : normalizeCommandToken(command);
	const config = await readConfig();
	if (command === undefined || normalized === "interactive" || normalized === "configure" || normalized === "edit") {
		if (flow === undefined) return `${await pushStatusText(config)}\n\n${pushUsage()}`;
		return await configurePushInteractive(flow, config);
	}
	const action = parsePushCommandAction(command);
	if (action === undefined) return `Unknown /push option "${command}". Use status, test, key-path, key-id, team-id, bundle-id, env, or clear.`;
	if (action === "status") return await pushStatusText(config);
	if (action === "help") return pushUsage();
	if (action === "test") return await sendPushTestNotification();
	if (action === "clear") return await savePushConfigUpdate(buildPushClearUpdate());
	if (args[1] === undefined) {
		if (flow === undefined) return `Usage: /push ${action} <value>\n\n${await pushStatusText(config)}`;
		const update = await promptPushConfigField(flow, config, action);
		return update === undefined ? "/push cancelled." : await savePushConfigUpdate(update);
	}
	const update = buildPushSetUpdate(action, args.slice(1).join(" "));
	return typeof update === "string" ? update : await savePushConfigUpdate(update);
}

async function configurePushInteractive(flow: SetupFlow, config: ClankyConfig): Promise<string> {
	const devices = await safeListPushDevices();
	const status = await formatPushMenuStatus(config, devices);
	flow.begin("Configure push notifications");
	try {
		const result = await settingsLoop(flow, {
			title: "Choose the push notification setting to change.",
			options: () => PUSH_ACTION_OPTIONS,
			renderStatus: () => status,
			initial: "key-path",
			dispatch: async (action) => {
				const parsed = parsePushCommandAction(action);
				if (parsed === "test") return await sendPushTestNotification();
				if (parsed === "clear") return await savePushConfigUpdate(buildPushClearUpdate());
				if (parsed === "status" || parsed === "help" || parsed === undefined) return undefined;
				const update = await promptPushConfigField(flow, config, parsed);
				return update === undefined ? undefined : await savePushConfigUpdate(update);
			},
		});
		return result ?? "/push cancelled.";
	} finally {
		flow.end({ preserveDiagnostics: false });
	}
}

async function promptPushConfigField(
	flow: SetupFlow,
	config: ClankyConfig,
	field: PushConfigField,
): Promise<PushConfigUpdate | undefined> {
	if (field === "env") {
		const selected = await selectOne(
			flow,
			"Choose which APNs endpoint Clanky should send to.",
			PUSH_APNS_ENV_OPTIONS,
			parsePushApnsEnvironment(config.apnsEnvironment) ?? DEFAULT_APNS_ENVIRONMENT,
			true,
		);
		return selected === undefined ? undefined : buildPushSetUpdate("env", selected) as PushConfigUpdate;
	}
	const value = await flow.readText({
		message: pushFieldPrompt(field),
		defaultValue: pushFieldCurrentValue(config, field),
		placeholder: pushFieldPlaceholder(field),
		allowBack: true,
		validate: pushFieldValidator(field),
	});
	if (value === undefined) return undefined;
	const update = buildPushSetUpdate(field, value);
	return typeof update === "string" ? undefined : update;
}

function parsePushCommandAction(value: string | undefined): PushCommandAction | undefined {
	if (value === undefined) return undefined;
	const normalized = normalizeCommandToken(value);
	if (normalized === "show" || normalized === "view") return "status";
	if (normalized === "status") return "status";
	if (normalized === "test" || normalized === "sendtest") return "test";
	if (normalized === "keypath" || normalized === "path" || normalized === "key") return "key-path";
	if (normalized === "keyid" || normalized === "kid") return "key-id";
	if (normalized === "teamid" || normalized === "team") return "team-id";
	if (normalized === "bundleid" || normalized === "bundle" || normalized === "topic") return "bundle-id";
	if (normalized === "env" || normalized === "environment" || normalized === "apnsenv") return "env";
	if (normalized === "clear" || normalized === "reset" || normalized === "unset") return "clear";
	if (normalized === "help") return "help";
	return undefined;
}

function buildPushSetUpdate(field: PushConfigField, rawValue: string): PushConfigUpdate | string {
	const value = rawValue.trim();
	if (isClearSettingValue(value)) return buildPushFieldClearUpdate(field);
	const validation = pushFieldValidator(field)(value);
	if (validation !== undefined) return validation;
	switch (field) {
		case "key-path":
			return {
				updates: { [PUSH_APNS_ENV.keyPath]: value },
				removals: [PUSH_APNS_ENV.keyAlias],
				message: `APNs key path set to ${displayHomePath(value)}`,
			};
		case "key-id":
			return { updates: { [PUSH_APNS_ENV.keyId]: value.toUpperCase() }, removals: [], message: "APNs key ID saved" };
		case "team-id":
			return { updates: { [PUSH_APNS_ENV.teamId]: value.toUpperCase() }, removals: [], message: "Apple team ID saved" };
		case "bundle-id":
			return { updates: { [PUSH_APNS_ENV.bundleId]: value }, removals: [], message: `APNs bundle id set to ${value}` };
		case "env": {
			const environment = parsePushApnsEnvironment(value);
			if (environment === undefined) return "Use sandbox/development or production.";
			return { updates: { [PUSH_APNS_ENV.environment]: environment }, removals: [], message: `APNs environment set to ${environment}` };
		}
	}
}

function buildPushFieldClearUpdate(field: PushConfigField): PushConfigUpdate {
	switch (field) {
		case "key-path":
			return { updates: {}, removals: [PUSH_APNS_ENV.keyPath, PUSH_APNS_ENV.keyAlias], message: "APNs key path cleared" };
		case "key-id":
			return { updates: {}, removals: [PUSH_APNS_ENV.keyId], message: "APNs key ID cleared" };
		case "team-id":
			return { updates: {}, removals: [PUSH_APNS_ENV.teamId], message: "Apple team ID cleared" };
		case "bundle-id":
			return { updates: {}, removals: [PUSH_APNS_ENV.bundleId], message: `APNs bundle id cleared (default ${DEFAULT_APNS_BUNDLE_ID})` };
		case "env":
			return { updates: {}, removals: [PUSH_APNS_ENV.environment], message: `APNs environment cleared (default ${DEFAULT_APNS_ENVIRONMENT})` };
	}
}

function buildPushClearUpdate(): PushConfigUpdate {
	return {
		updates: {},
		removals: Object.values(PUSH_APNS_ENV),
		message: "APNs push configuration cleared",
	};
}

async function savePushConfigUpdate(update: PushConfigUpdate): Promise<string> {
	await updateEnv(update.updates, update.removals);
	const message = await restartBrainMessage(update.message);
	return `${message}\n${await pushStatusText(await readConfig())}`;
}

async function pushStatusText(config?: ClankyConfig): Promise<string> {
	const effectiveConfig = config ?? await readConfig();
	return formatPushStatus(effectiveConfig, await safeListPushDevices(), await pushKeyPathStatus(effectiveConfig.apnsKeyPath));
}

async function formatPushMenuStatus(config: ClankyConfig, devices: readonly PushDevice[]): Promise<SettingsMenuStatus> {
	const collapsed = formatPushSummary(config, devices);
	const expanded = formatPushStatus(config, devices, await pushKeyPathStatus(config.apnsKeyPath));
	return collapsibleMenuStatus(collapsed, expanded);
}

function formatPushSummary(config: ClankyConfig, devices: readonly PushDevice[]): string {
	const configured = pushApnsConfigured(config);
	return [
		statusTitle("Push notifications"),
		[
			statusInline("APNs", configured ? "configured" : "missing credentials", configured ? "ok" : "warn"),
			statusInline("env", parsePushApnsEnvironment(config.apnsEnvironment) ?? DEFAULT_APNS_ENVIRONMENT, "muted"),
			statusInline("devices", String(devices.length), devices.length > 0 ? "ok" : "warn"),
		].join("; "),
	].join("\n");
}

function formatPushStatus(
	config: ClankyConfig,
	devices: readonly PushDevice[],
	keyPathStatus: "unset" | "readable" | "unreadable",
): string {
	const configured = pushApnsConfigured(config);
	const keyPath = config.apnsKeyPath;
	const environment = parsePushApnsEnvironment(config.apnsEnvironment) ?? DEFAULT_APNS_ENVIRONMENT;
	const deviceList = devices.length === 0 ? "(none)" : devices.map((device) => `${maskPushToken(device.token)} ${device.platform}`).join(", ");
	const lines = [
		statusTitle("Push notifications"),
		statusLine("APNs", configured ? "configured" : "missing credentials", configured ? "ok" : "warn"),
		statusLine(
			"key path",
			keyPath === undefined ? "(unset)" : displayHomePath(keyPath),
			keyPathStatus === "readable" ? "ok" : keyPathStatus === "unreadable" ? "bad" : "warn",
		),
		statusLine("key id", config.apnsKeyId === undefined ? "(unset)" : config.apnsKeyId, config.apnsKeyId === undefined ? "warn" : "ok"),
		statusLine("team id", config.apnsTeamId === undefined ? "(unset)" : config.apnsTeamId, config.apnsTeamId === undefined ? "warn" : "ok"),
		statusLine("bundle id", config.apnsBundleId ?? DEFAULT_APNS_BUNDLE_ID, config.apnsBundleId === undefined ? "muted" : "ok"),
		statusLine("environment", environment, environment === "sandbox" ? "muted" : "active"),
		statusLine("registered devices", `${devices.length}${devices.length === 0 ? "" : ` (${deviceList})`}`, devices.length > 0 ? "ok" : "warn"),
	];
	if (!configured) {
		lines.push("", "Run /push to set APNs key path, key id, and team id. Store only the .p8 file path, not the key contents.");
	}
	if (devices.length === 0) {
		lines.push("", "Register an iPhone from Clanky iOS Settings -> Enable notifications, then run /push test.");
	}
	return lines.join("\n");
}

async function sendPushTestNotification(): Promise<string> {
	const config = await readConfig();
	const env = await readPushEnv();
	const apns = apnsConfigFromEnv(env);
	const devices = await safeListPushDevices();
	if (apns === undefined) return `${await pushStatusText(config)}\n\nAPNs is not configured; set key path, key id, and team id first.`;
	if (devices.length === 0) return `${await pushStatusText(config)}\n\nNo registered iOS devices. Enable notifications in the app first.`;
	const note = {
		title: "Clanky test",
		body: "Push notifications are wired.",
		collapseId: `clanky-test-${Date.now()}`,
		data: { status: "test", test: "1" },
	};
	const results = await Promise.all(
		devices.map(async (device) => ({ device, result: await sendApns(device.token, note, apns) })),
	);
	const okCount = results.filter((entry) => entry.result.ok).length;
	const lines = [
		statusTitle("Push test"),
		statusLine("APNs host", apns.host, "muted"),
		statusLine("sent", `${okCount}/${results.length}`, okCount === results.length ? "ok" : "warn"),
		...results.map(({ device, result }) =>
			statusLine(
				maskPushToken(device.token),
				result.ok ? "ok" : `${result.reason ?? `HTTP ${result.status ?? "?"}`}`,
				result.ok ? "ok" : "bad",
			),
		),
	];
	return lines.join("\n");
}

async function readPushEnv(): Promise<NodeJS.ProcessEnv> {
	const content = await readFile(ENV_PATH, "utf8").catch(() => "");
	const fileEnv = content.trim().length === 0 ? {} : parseEnv(content);
	return { ...process.env, ...fileEnv };
}

async function safeListPushDevices(): Promise<readonly PushDevice[]> {
	try {
		return await listPushDevices();
	} catch {
		return [];
	}
}

async function pushKeyPathStatus(keyPath: string | undefined): Promise<"unset" | "readable" | "unreadable"> {
	if (keyPath === undefined || keyPath.trim().length === 0) return "unset";
	try {
		await access(keyPath);
		return "readable";
	} catch {
		return "unreadable";
	}
}

function pushApnsConfigured(config: ClankyConfig): boolean {
	return [config.apnsKeyPath, config.apnsKeyId, config.apnsTeamId].every((value) => value !== undefined && value.trim().length > 0);
}

function pushFieldPrompt(field: PushConfigField): string {
	switch (field) {
		case "key-path":
			return "Path to the Apple APNs AuthKey_XXXX.p8 file. Do not paste the key contents.";
		case "key-id":
			return "Apple APNs key ID.";
		case "team-id":
			return "Apple Developer Team ID.";
		case "bundle-id":
			return "APNs topic / iOS bundle id.";
		case "env":
			return "APNs environment.";
	}
}

function pushFieldPlaceholder(field: PushConfigField): string {
	switch (field) {
		case "key-path":
			return "/path/to/AuthKey_XXXXXXXXXX.p8";
		case "key-id":
			return "XXXXXXXXXX";
		case "team-id":
			return "XXXXXXXXXX";
		case "bundle-id":
			return DEFAULT_APNS_BUNDLE_ID;
		case "env":
			return DEFAULT_APNS_ENVIRONMENT;
	}
}

function pushFieldCurrentValue(config: ClankyConfig, field: PushConfigField): string | undefined {
	switch (field) {
		case "key-path":
			return config.apnsKeyPath;
		case "key-id":
			return config.apnsKeyId;
		case "team-id":
			return config.apnsTeamId;
		case "bundle-id":
			return config.apnsBundleId ?? DEFAULT_APNS_BUNDLE_ID;
		case "env":
			return parsePushApnsEnvironment(config.apnsEnvironment) ?? DEFAULT_APNS_ENVIRONMENT;
	}
}

function pushFieldValidator(field: PushConfigField): (value: string) => string | undefined {
	return (value) => {
		const trimmed = value.trim();
		if (isClearSettingValue(trimmed)) return undefined;
		if (trimmed.length === 0) return "Enter a value, or use /push clear to remove APNs config.";
		if (field === "key-path") {
			if (/BEGIN\s+(?:EC\s+)?PRIVATE\s+KEY/u.test(trimmed) || trimmed.includes("\n")) return "Enter a filesystem path, not .p8 key contents.";
			return undefined;
		}
		if ((field === "key-id" || field === "team-id") && !/^[A-Za-z0-9]{10}$/u.test(trimmed)) return "Apple APNs key/team ids are 10 alphanumeric characters.";
		if (field === "bundle-id" && !/^[A-Za-z0-9][A-Za-z0-9.-]+$/u.test(trimmed)) return "Enter a valid bundle id, e.g. io.clanky.ios.";
		if (field === "env" && parsePushApnsEnvironment(trimmed) === undefined) return "Use sandbox/development or production.";
		return undefined;
	};
}

function parsePushApnsEnvironment(value: string | undefined): PushApnsEnvironment | undefined {
	const normalized = value?.trim().toLowerCase();
	if (normalized === "sandbox" || normalized === "development" || normalized === "debug" || normalized === "dev") return "sandbox";
	if (normalized === "production" || normalized === "release" || normalized === "prod") return "production";
	return undefined;
}

function isClearSettingValue(value: string): boolean {
	const normalized = value.trim().toLowerCase();
	return normalized === "clear" || normalized === "unset" || normalized === "none" || normalized === "default";
}

function maskPushToken(token: string): string {
	const trimmed = token.trim();
	if (trimmed.length <= 10) return trimmed.length === 0 ? "(empty-token)" : trimmed;
	return `${trimmed.slice(0, 4)}…${trimmed.slice(-6)}`;
}

function pushUsage(): string {
	return [
		"Usage:",
		"/push",
		"/push status",
		"/push key-path /path/to/AuthKey_XXXXXXXXXX.p8",
		"/push key-id XXXXXXXXXX",
		"/push team-id XXXXXXXXXX",
		`/push bundle-id ${DEFAULT_APNS_BUNDLE_ID}`,
		"/push env sandbox|production",
		"/push test",
		"/push clear",
	].join("\n");
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

async function configureAuth(
	argument: string,
	flow: SetupFlow | undefined,
	renderer: CommandRenderer,
): Promise<string> {
	const args = splitArgs(argument);
	const action = parseAuthAction(args[0]);
	if (args[0] !== undefined && action === undefined) return `Unknown /auth target "${args[0]}".\n\n${authUsage()}`;
	if (action === undefined) {
		if (flow === undefined) return `${await authStatusText()}\n\n${authUsage()}`;
		return await configureAuthInteractive(flow, renderer);
	}
	if (action === "status") return await authStatusText();
	return (await runAuthAction(action, args.slice(1), flow, renderer)) ?? `/auth ${action} cancelled.`;
}

async function configureAuthInteractive(flow: SetupFlow, renderer: CommandRenderer): Promise<string> {
	const runGroup = async (title: string, options: readonly MenuOption[]): Promise<string | undefined> =>
		await settingsLoop(flow, {
			title,
			options: () => options,
			initial: options[0]?.value,
			dispatch: async (value) => {
				const action = parseAuthAction(value);
				if (action === undefined || action === "status") return undefined;
				return await runAuthAction(action, [], flow, renderer, { backReturnsToMenu: true });
			},
		});
	// Status is read once: every credential action closes the flow, so it never
	// goes stale while the menu is open.
	const status = await authMenuStatus();
	flow.begin("Auth & Credentials");
	try {
		const result = await settingsLoop(flow, {
			title: "Choose the login or credential to configure.",
			options: () => AUTH_GROUP_OPTIONS,
			renderStatus: () => status,
			dispatch: async (choice) => {
				switch (choice) {
					case "group:subscriptions":
						return await runGroup("Choose a subscription login.", AUTH_SUBSCRIPTION_OPTIONS);
					case "group:keys":
						return await runGroup("Choose an API key to set.", AUTH_KEY_OPTIONS);
					case "group:tokens":
						return await runGroup("Choose a token to set.", AUTH_TOKEN_OPTIONS);
					case "mcp":
						return await runAuthAction("mcp", [], flow, renderer, { backReturnsToMenu: true });
					default:
						return undefined;
				}
			},
		});
		return result ?? "/auth cancelled.";
	} finally {
		flow.end({ preserveDiagnostics: false });
	}
}

async function runAuthAction(
	action: AuthAction,
	args: readonly string[],
	flow: SetupFlow | undefined,
	renderer: CommandRenderer,
	options: MenuBackOptions = {},
): Promise<string | undefined> {
	switch (action) {
		case "status":
			return await authStatusText();
		case "login":
			return await configureLogin(args.join(" "), flow);
		case "codex":
		case "claude":
			if (args[0]?.toLowerCase() === "status" || args[0]?.toLowerCase() === "show") return await loginStatusText();
			if (flow === undefined) return `/auth ${action} needs an interactive terminal. Run pnpm ${action}:login instead.`;
			return await runLogin(action, flow);
		case "xai":
		case "gemini":
			return await setProviderApiKeyFromAuth(action, args, flow, options);
		case "openai":
		case "elevenlabs":
		case "relay":
		case "local-voice":
			return await setAuthSecret(action, args, flow, options);
		case "discord":
			return await setDiscordToken(args.join(" "), flow, options);
		case "mcp":
			if (options.backReturnsToMenu === true && flow !== undefined && args.length === 0) {
				return await configureMcpInteractive(flow, renderer, "auth", options);
			}
			return await configureMcp(["auth", ...args].join(" "), flow, renderer);
	}
}

async function setProviderApiKeyFromAuth(
	provider: "xai" | "gemini",
	args: readonly string[],
	flow: SetupFlow | undefined,
	options: MenuBackOptions = {},
): Promise<string | undefined> {
	if (args[0]?.toLowerCase() === "status" || args[0]?.toLowerCase() === "show") return await authStatusText();
	const directValue = args.join(" ").trim();
	if (directValue.length > 0) return await saveProviderApiKey(provider, directValue);
	if (flow === undefined) return `Usage: /auth ${provider} <api-key>`;
	const entered = await promptProviderApiKey(flow, provider, await readConfig(), options.backReturnsToMenu === true);
	if (entered === undefined) return options.backReturnsToMenu === true ? undefined : `/auth ${provider} cancelled.`;
	if (entered === "keep") return `${providerLabel(provider)} API key unchanged.`;
	return await saveProviderApiKey(provider, entered);
}

async function saveProviderApiKey(provider: "xai" | "gemini", value: string): Promise<string> {
	await writeEnv({ [providerApiKeyEnvKey(provider)]: value.trim() });
	return await restartBrainMessage(`${providerLabel(provider)} API key saved`);
}

async function setAuthSecret(
	action: AuthSecretAction,
	args: readonly string[],
	flow: SetupFlow | undefined,
	options: MenuBackOptions = {},
): Promise<string | undefined> {
	if (args[0]?.toLowerCase() === "status" || args[0]?.toLowerCase() === "show") return await authStatusText();
	const target = AUTH_SECRET_TARGETS[action];
	const directValue = args.join(" ").trim();
	if (directValue.length > 0) return await saveAuthSecret(target.envKey, directValue, target.savedMessage);
	const config = await readConfig();
	const present = authSecretPresent(action, config);
	if (flow === undefined) return `Usage: /auth ${action} <value>`;
	flow.begin(`Set ${target.label}`);
	try {
		flow.renderOutput(`${target.label}: ${formatCredentialPresence(present)}`);
		const value = await flow.readText({
			message: present
				? `Paste the ${target.label} to replace the current one. Leave blank to keep it.`
				: `Paste the ${target.label} to store it in .env.local. Leave blank to cancel.`,
			placeholder: target.placeholder,
			allowBack: options.backReturnsToMenu === true,
		});
		if (value === undefined) return options.backReturnsToMenu === true ? undefined : `/auth ${action} cancelled.`;
		const trimmed = value.trim();
		if (trimmed.length === 0) return present ? `${target.label} unchanged.` : `${target.label} not changed.`;
		return await saveAuthSecret(target.envKey, trimmed, target.savedMessage);
	} finally {
		flow.end({ preserveDiagnostics: false });
	}
}

async function saveAuthSecret(envKey: string, value: string, message: string): Promise<string> {
	await writeEnv({ [envKey]: value.trim() });
	return await restartBrainMessage(message);
}

async function authStatusText(config?: ClankyConfig): Promise<string> {
	return (await buildAuthStatus(config)).expanded;
}

async function authMenuStatus(config?: ClankyConfig): Promise<SettingsMenuStatus> {
	const status = await buildAuthStatus(config);
	return collapsibleMenuStatus(status.collapsed, status.expanded);
}

async function buildAuthStatus(config?: ClankyConfig): Promise<{ collapsed: string; expanded: string }> {
	const current = config ?? (await readConfig());
	const [claude, codex] = await Promise.all([claudeCredentialStatus(), codexCredentialStatus()]);
	const discordKind = current.discordCredentialKind === "user-token" ? "user-token" : "bot-token";
	const discordVoice = parseVoiceToggle(current.discordVoice) === true ? "on" : "off";
	const xaiReady = current.xaiApiKeyPresent === true ? "set" : "unset";
	const geminiReady = current.geminiApiKeyPresent === true ? "set" : "unset";
	return {
		collapsed: [
			statusTitle("Auth"),
			statusLine("conductor", formatRunningConductorSummary(current), "active"),
			[
				statusInline("xAI", xaiReady, current.xaiApiKeyPresent === true ? "ok" : "warn"),
				statusInline("Gemini", geminiReady, current.geminiApiKeyPresent === true ? "ok" : "warn"),
				statusInline("Discord", formatCredentialPresence(current.discordTokenPresent), current.discordTokenPresent === true ? "ok" : "warn"),
				statusInline("voice", discordVoice, discordVoice === "on" ? "ok" : "muted"),
			].join("; "),
		].join("\n"),
		expanded: [
			statusTitle("Auth & credentials"),
			statusLine("running conductor", formatRunningConductorSummary(current), "active"),
			statusSection("Subscriptions"),
			statusLine("codex", formatCredStatus(codex), codex.present ? "ok" : "warn"),
			statusLine("claude", formatCredStatus(claude), claude.present ? "ok" : "warn"),
			statusSection("API keys"),
			statusLine("xai", formatCredentialPresence(current.xaiApiKeyPresent), current.xaiApiKeyPresent === true ? "ok" : "warn"),
			statusLine("gemini", formatCredentialPresence(current.geminiApiKeyPresent), current.geminiApiKeyPresent === true ? "ok" : "warn"),
			statusLine("openai", formatCredentialPresence(current.openAiApiKeyPresent), current.openAiApiKeyPresent === true ? "ok" : "warn"),
			statusLine("elevenlabs", formatCredentialPresence(current.elevenLabsApiKeyPresent), current.elevenLabsApiKeyPresent === true ? "ok" : "warn"),
			statusLine("local voice", formatCredentialPresence(current.voiceLocalApiKeyPresent), current.voiceLocalApiKeyPresent === true ? "ok" : "warn"),
			statusSection("Tokens"),
			statusLine("discord", `${formatCredentialPresence(current.discordTokenPresent)} (${discordKind}, voice ${discordVoice})`, current.discordTokenPresent === true ? "ok" : "warn"),
			statusLine("relay", formatCredentialPresence(current.relayTokenPresent), current.relayTokenPresent === true ? "ok" : "warn"),
			statusLine("mcp connections", "run /auth mcp", "muted"),
	].join("\n"),
	};
}

function authUsage(): string {
	return [
		"Usage:",
		"/auth",
		"/auth status",
		"/auth codex | claude",
		"/auth xai|gemini|openai|elevenlabs|relay|local-voice <secret>",
		"/auth discord [status|<token>] [--user-token] [--voice]",
		"/auth mcp [connection]",
	].join("\n");
}

function parseAuthAction(value: string | undefined): AuthAction | undefined {
	if (value === undefined) return undefined;
	const normalized = normalizeCommandToken(value);
	switch (normalized) {
		case "status":
		case "show":
			return "status";
		case "codex":
			return "codex";
		case "claude":
			return "claude";
		case "xai":
		case "grok":
			return "xai";
		case "gemini":
		case "google":
			return "gemini";
		case "openai":
		case "openaiapi":
			return "openai";
		case "discord":
		case "discordtoken":
			return "discord";
		case "mcp":
		case "connections":
		case "connection":
			return "mcp";
		case "elevenlabs":
		case "11labs":
			return "elevenlabs";
		case "relay":
		case "frontdoor":
			return "relay";
		case "localvoice":
		case "voicekey":
			return "local-voice";
		case "login":
		case "subscription":
		case "oauth":
			return "login";
	}
	return undefined;
}

function formatCredentialPresence(present: boolean | undefined): string {
	return present === true ? "set" : "unset";
}

function authSecretPresent(action: AuthSecretAction, config: ClankyConfig): boolean {
	switch (action) {
		case "openai":
			return config.openAiApiKeyPresent === true;
		case "elevenlabs":
			return config.elevenLabsApiKeyPresent === true;
		case "relay":
			return config.relayTokenPresent === true;
		case "local-voice":
			return config.voiceLocalApiKeyPresent === true;
	}
}

function providerApiKeyEnvKey(provider: "xai" | "gemini"): string {
	return provider === "xai" ? "CLANKY_XAI_API_KEY" : "CLANKY_GEMINI_API_KEY";
}

function providerApiKeyPresent(provider: "xai" | "gemini", config: ClankyConfig): boolean {
	return provider === "xai" ? config.xaiApiKeyPresent === true : config.geminiApiKeyPresent === true;
}

function providerLabel(provider: "xai" | "gemini"): string {
	return provider === "xai" ? "xAI" : "Gemini";
}

async function configureLogin(argument: string, flow: SetupFlow | undefined): Promise<string> {
	const args = splitArgs(argument);
	const first = args[0]?.toLowerCase();
	if (first === "status" || first === "show") return await loginStatusText();
	let provider = parseSubscriptionProvider(first);
	if (first !== undefined && provider === undefined) {
		return `Unknown login target "${args[0]}". Use claude, codex, or status.`;
	}
	if (provider === undefined) {
		if (flow === undefined) return `${await loginStatusText()}\n\nUsage: /login [claude|codex|status]`;
		const selectedProvider = await selectLoginProvider(flow);
		if (selectedProvider === "status") return await loginStatusText();
		if (selectedProvider === undefined) return "/login cancelled.";
		provider = selectedProvider;
	}
	if (flow === undefined) {
		return `/login ${provider} needs an interactive terminal. Run pnpm ${provider}:login instead.`;
	}
	return await runLogin(provider, flow);
}

async function selectLoginProvider(flow: SetupFlow): Promise<SubscriptionProvider | "status" | undefined> {
	flow.begin("Authorize a subscription provider");
	try {
		flow.renderOutput(await loginStatusText());
		const selected = await selectOne(
			flow,
			"Choose the subscription provider to authorize.",
			[
				{ value: "status", label: "status", hint: "show current auth state" },
				{ value: "codex", label: "codex", hint: "OpenAI ChatGPT subscription" },
				{ value: "claude", label: "claude", hint: "Claude Pro/Max subscription" },
			],
			"status",
			true,
		);
		if (selected === "status") return "status";
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

async function subscriptionCredentialStatus(provider: SubscriptionProvider): Promise<{ present: boolean; expiresMs?: number }> {
	return provider === "claude" ? await claudeCredentialStatus() : await codexCredentialStatus();
}

function subscriptionCredentialNeedsLogin(status: { present: boolean; expiresMs?: number }): boolean {
	if (!status.present) return true;
	return status.expiresMs !== undefined && status.expiresMs <= Date.now();
}

async function promptSubscriptionLoginIfNeeded(
	flow: SetupFlow,
	provider: SubscriptionProvider,
): Promise<SubscriptionLoginPromptResult> {
	const status = await subscriptionCredentialStatus(provider);
	if (!subscriptionCredentialNeedsLogin(status)) return { state: "ready" };
	const label = provider === "claude" ? "Claude" : "Codex";
	let selected: string | undefined;
	flow.begin(`Authorize ${label}`);
	try {
		selected = await selectOne(
			flow,
			`${label} subscription auth is ${formatCredStatus(status)}. Login now?`,
			[
				{ value: "login", label: "log in", hint: "open browser authorization" },
				{ value: "skip", label: "skip", hint: "switch model route without refreshing auth" },
			],
			"login",
		);
	} finally {
		flow.end({ preserveDiagnostics: false });
	}
	if (selected === undefined) return { state: "cancelled", message: "/model cancelled." };
	if (selected !== "login") return { state: "skip" };
	const message = await runLogin(provider, flow);
	if (subscriptionCredentialNeedsLogin(await subscriptionCredentialStatus(provider))) return { state: "cancelled", message };
	return { state: "ready", message };
}

// Where the active conductor route runs. Derived, never stored: a local route runs
// on this machine; every hosted route (codex/claude/xai/gemini) runs off-box. Keeping
// this derived avoids representable-but-contradictory states like "location local,
// route codex".
function conductorLocation(provider: ClankyConfig["provider"]): "local" | "hosted" {
	return provider === "local" ? "local" : "hosted";
}

// The model id actually driving conductor turns for the active route. The per-route
// model fields all persist independently in .env.local; this picks the live one.
function activeConductorModel(config: ClankyConfig): string {
	switch (config.provider) {
		case "codex":
			return config.codexModel ?? DEFAULT_CODEX_MODEL;
		case "claude":
			return config.claudeModel ?? DEFAULT_CLAUDE_MODEL;
		case "local":
			return config.localModel ?? DEFAULT_LOCAL_MODEL;
		case "xai":
			return config.xaiModel ?? DEFAULT_XAI_MODEL;
		case "gemini":
			return config.geminiModel ?? DEFAULT_GEMINI_MODEL;
	}
}

function formatProviderSummary(config: ClankyConfig): string {
	return `${config.provider} / ${activeConductorModel(config)} (${conductorLocation(config.provider)})`;
}

function formatRunningConductorSummary(config: ClankyConfig): string {
	if (startupModelFallback !== undefined && config.provider === startupModelFallback.provider) {
		return `codex / ${config.codexModel ?? DEFAULT_CODEX_MODEL} (hosted, temporary fallback; missing ${startupModelFallback.envNames})`;
	}
	return formatProviderSummary(config);
}

function formatCredStatus(status: { present: boolean; expiresMs?: number }): string {
	if (!status.present) return "not logged in";
	if (status.expiresMs === undefined) return "logged in";
	const state = status.expiresMs <= Date.now() ? "expired" : "valid";
	return `${state} (expires ${new Date(status.expiresMs).toISOString()})`;
}

function credentialStatusTone(status: { present: boolean; expiresMs?: number }): StatusTone {
	if (!status.present) return "warn";
	return status.expiresMs !== undefined && status.expiresMs <= Date.now() ? "bad" : "ok";
}

async function configureModel(argument: string, flow: SetupFlow | undefined): Promise<string> {
	const args = splitArgs(argument);
	const existing = await readConfig();
	const first = args[0]?.toLowerCase();
	if (first === "status" || first === "show") return await formatModelStatusWithAuth(existing);
	let provider = parseProvider(args[0]);
	let modelId = provider === undefined ? undefined : args[1];
	let effort = provider === undefined ? undefined : args[2];
	const baseUrl = provider === "local" ? args[2] : undefined;
	let apiKey: string | undefined;
	let providerSelectedInteractively = false;
	const loginMessages: string[] = [];

	if (provider === undefined && args.length > 0) {
		return `Unknown model provider "${args[0]}". Use codex, claude, local, xai, gemini, or status.`;
	}

	for (;;) {
		if (provider === undefined) {
			if (flow === undefined) return `${await formatModelStatusWithAuth(existing)}\n\nUsage: /model [status|codex|claude|local|xai|gemini] [id] [effort|baseUrl]`;
			const modelMenuStatus = await formatModelMenuStatusWithAuth(existing);
			// Provider -> model -> (codex effort) wizard. Left/Esc steps back one
			// stage; backing out of the provider step cancels the command.
			let step: "provider" | "model" | "effort" = "provider";
			let wizardProvider: ClankyConfig["provider"] | undefined;
			let wizardModel: string | undefined;
			let wizardEffort: string | undefined;
			for (;;) {
				if (step === "provider") {
					const selectedProvider = await selectProvider(flow, wizardProvider ?? existing.provider, true, modelMenuStatus);
					if (selectedProvider === undefined) return "/model cancelled.";
					wizardProvider = selectedProvider;
					step = "model";
					continue;
				}
				if (wizardProvider === undefined) {
					step = "provider";
					continue;
				}
				if (step === "model") {
					const picked = await selectModel(flow, wizardProvider, existing, true);
					if (picked === undefined) {
						step = "provider";
						continue;
					}
					wizardModel = picked;
					step = "effort";
					continue;
				}
				if (wizardProvider === "codex") {
					const pickedEffort = await selectEffort(flow, existing.codexEffort, false, true);
					if (pickedEffort === undefined) {
						step = "model";
						continue;
					}
					wizardEffort = pickedEffort;
				}
				break;
			}
			if (wizardProvider === undefined) return "/model cancelled.";
			provider = wizardProvider;
			providerSelectedInteractively = true;
			modelId = wizardModel === "keep-current" ? undefined : wizardModel;
			if (wizardProvider === "codex") effort = wizardEffort === "keep-current" ? undefined : wizardEffort;
		}

		if ((provider === "codex" || provider === "claude") && flow !== undefined) {
			const login = await promptSubscriptionLoginIfNeeded(flow, provider);
			if (login.state === "cancelled") return login.message;
			if (login.state === "ready" && login.message !== undefined) loginMessages.push(login.message);
		}

		if (
			(provider === "xai" || provider === "gemini") &&
			apiKey === undefined &&
			flow !== undefined &&
			(providerSelectedInteractively || !providerApiKeyPresent(provider, existing))
		) {
			const entered = await promptProviderApiKey(flow, provider, existing, providerSelectedInteractively);
			if (entered === undefined) {
				if (!providerSelectedInteractively) return "/model cancelled.";
				provider = undefined;
				providerSelectedInteractively = false;
				modelId = undefined;
				effort = undefined;
				apiKey = undefined;
				continue;
			}
			if (entered !== "keep") apiKey = entered;
		}
		break;
	}

	if (provider === undefined) return "/model cancelled.";

	const updates: Record<string, string> = { CLANKY_MODEL_PROVIDER: provider };
	if (provider === "local") {
		updates.CLANKY_LOCAL_BASE_URL = baseUrl ?? existing.localBaseUrl ?? DEFAULT_LOCAL_BASE_URL;
		if (modelId !== undefined && modelId.length > 0) updates.CLANKY_LOCAL_MODEL = modelId;
	} else {
		if (modelId !== undefined && modelId.length > 0) {
			const modelEnvKey = MODEL_ENV_KEY[provider];
			updates[modelEnvKey] = modelId;
		}
		if (provider === "codex" && effort !== undefined && effort.length > 0) {
			if (!isEffortLevel(effort)) return `Unknown Codex effort "${effort}".`;
			updates.CLANKY_CODEX_EFFORT = effort;
		}
		if ((provider === "xai" || provider === "gemini") && apiKey !== undefined && apiKey.length > 0) {
			updates[providerApiKeyEnvKey(provider)] = apiKey;
		}
	}

	await writeEnv(updates);
	const keyProvided = apiKey !== undefined && apiKey.length > 0;
	const authHint = await modelRouteAuthHint(provider, keyProvided, existing);
	const restart = await restartBrainMessage(`Model provider set to ${provider}${modelId ? ` (${modelId})` : ""}${authHint}`);
	return [...loginMessages, restart].join("\n\n");
}

function formatModelStatus(config: ClankyConfig): string {
	const configured = formatProviderSummary(config);
	const running = formatRunningConductorSummary(config);
	const lines = [
		statusTitle("Model routing"),
		statusLine("running conductor", running, running !== configured ? "warn" : "active"),
	];
	if (running !== configured) lines.push(statusLine("configured route", configured, "muted"));
	lines.push(
		"",
		statusSection("Saved route settings"),
		statusLine("codex", `${config.codexModel ?? DEFAULT_CODEX_MODEL}; effort ${config.codexEffort ?? "(backend default)"}`),
		statusLine("claude", config.claudeModel ?? DEFAULT_CLAUDE_MODEL),
		statusLine("local", `${config.localModel ?? DEFAULT_LOCAL_MODEL} @ ${config.localBaseUrl ?? DEFAULT_LOCAL_BASE_URL}; effort ${config.localEffort ?? "(server default)"}`),
		statusLine("xai", `${config.xaiModel ?? DEFAULT_XAI_MODEL}; api key ${formatCredentialPresence(config.xaiApiKeyPresent)}`, config.xaiApiKeyPresent === true ? "normal" : "warn"),
		statusLine("gemini", `${config.geminiModel ?? DEFAULT_GEMINI_MODEL}; api key ${formatCredentialPresence(config.geminiApiKeyPresent)}`, config.geminiApiKeyPresent === true ? "normal" : "warn"),
	);
	return lines.join("\n");
}

async function formatModelStatusWithAuth(config: ClankyConfig): Promise<string> {
	return formatModelStatusWithAuthFromStatuses(config, await subscriptionAuthStatuses());
}

async function formatModelMenuStatusWithAuth(config: ClankyConfig): Promise<SettingsMenuStatus> {
	const auth = await subscriptionAuthStatuses();
	return collapsibleMenuStatus(formatModelMenuSummary(config, auth), formatModelStatusWithAuthFromStatuses(config, auth));
}

type SubscriptionAuthStatuses = {
	readonly claude: { present: boolean; expiresMs?: number };
	readonly codex: { present: boolean; expiresMs?: number };
};

async function subscriptionAuthStatuses(): Promise<SubscriptionAuthStatuses> {
	const [claude, codex] = await Promise.all([claudeCredentialStatus(), codexCredentialStatus()]);
	return { claude, codex };
}

function formatModelStatusWithAuthFromStatuses(
	config: ClankyConfig,
	auth: SubscriptionAuthStatuses,
): string {
	return [
		formatModelStatus(config),
		statusSection("Subscription auth"),
		statusLine("codex", formatCredStatus(auth.codex), credentialStatusTone(auth.codex)),
		statusLine("claude", formatCredStatus(auth.claude), credentialStatusTone(auth.claude)),
	].join("\n");
}

function formatModelMenuSummary(
	config: ClankyConfig,
	auth: SubscriptionAuthStatuses,
): string {
	const configured = formatProviderSummary(config);
	const running = formatRunningConductorSummary(config);
	const lines = [statusTitle("Model"), statusLine("running", running, running !== configured ? "warn" : "active")];
	if (running !== configured) lines.push(statusLine("configured", configured, "muted"));
	lines.push(formatActiveModelGate(config, auth));
	return lines.join("\n");
}

function formatActiveModelGate(
	config: ClankyConfig,
	auth: SubscriptionAuthStatuses,
): string {
	switch (config.provider) {
		case "codex":
			return statusLine("auth", `codex ${formatCredStatus(auth.codex)}`, credentialStatusTone(auth.codex));
		case "claude":
			return statusLine("auth", `claude ${formatCredStatus(auth.claude)}`, credentialStatusTone(auth.claude));
		case "xai":
			return statusLine("auth", `xai api key ${formatCredentialPresence(config.xaiApiKeyPresent)}`, config.xaiApiKeyPresent === true ? "ok" : "warn");
		case "gemini":
			return statusLine(
				"auth",
				`gemini api key ${formatCredentialPresence(config.geminiApiKeyPresent)}`,
				config.geminiApiKeyPresent === true ? "ok" : "warn",
			);
		case "local":
			return statusLine("endpoint", config.localBaseUrl ?? DEFAULT_LOCAL_BASE_URL, "muted");
	}
}

async function modelRouteAuthHint(
	provider: ClankyConfig["provider"],
	apiKeyProvided: boolean,
	config: ClankyConfig,
): Promise<string> {
	if (provider === "xai" && !(apiKeyProvided || providerApiKeyPresent(provider, config))) {
		return " — run /auth xai to set CLANKY_XAI_API_KEY";
	}
	if (provider === "gemini" && !(apiKeyProvided || providerApiKeyPresent(provider, config))) {
		return " — run /auth gemini to set CLANKY_GEMINI_API_KEY";
	}
	if (provider === "codex" || provider === "claude") {
		const status = await subscriptionCredentialStatus(provider);
		if (subscriptionCredentialNeedsLogin(status)) return ` — run /auth ${provider} to authorize the subscription`;
	}
	return "";
}

async function configureProfile(argument: string, flow: SetupFlow | undefined): Promise<string> {
	const args = splitArgs(argument);
	const config = await readConfig();
	const first = args[0]?.toLowerCase();
	if (first === "status" || first === "show") return await formatProfileStatus(config);
	let action: ProfileAction | undefined = parseProfileAction(first);
	if (action === undefined && first !== undefined) {
		return `Unknown /profile option "${args[0]}". Use status, local-tiered, local-single, api, local-api, or api-local.`;
	}
	if (action === undefined) {
		if (flow === undefined) return `${await formatProfileStatus(config)}\n\n${profileUsage()}`;
		action = await selectProfileAction(flow, config);
		if (action === undefined) return "/profile cancelled.";
	}
	const voiceModelOverride = args[1]?.trim();
	if (action === "api") return await applyApiStackProfile(config);
	if (action === "local-api") return await applyLocalApiProfile(config);
	if (action === "api-local") return await applyApiLocalProfile(config, voiceModelOverride);
	return await applyLocalProfile(action, config, voiceModelOverride);
}

type LocalProfile = "local-tiered" | "local-single";
type ProfileAction = LocalProfile | "api" | "local-api" | "api-local";
type ApiModelProvider = Exclude<ClankyConfig["provider"], "local">;
type ApiVoiceProvider = Exclude<VoiceRealtimeProvider, "local">;

function parseProfileAction(value: string | undefined): ProfileAction | undefined {
	if (value === undefined) return undefined;
	const normalized = normalizeCommandToken(value);
	if (normalized === "localtiered") return "local-tiered";
	if (normalized === "localsingle") return "local-single";
	if (normalized === "api") return "api";
	if (normalized === "localapi") return "local-api";
	if (normalized === "apilocal") return "api-local";
	return undefined;
}

async function selectProfileAction(flow: SetupFlow, config: ClankyConfig): Promise<ProfileAction | undefined> {
	flow.begin("Configure profile");
	let statusExpanded = false;
	let expandedStatus: string | undefined;
	let initial: string | undefined = currentProfileAction(config);
	const toggleStatus: Exclude<SettingsMenuStatus, string> = { collapsed: "", expanded: "" };
	try {
		for (;;) {
			if (statusExpanded && expandedStatus === undefined) expandedStatus = await formatProfileStatus(config);
			const status = statusExpanded ? expandedStatus : formatProfileSummary(config);
			const message = `${status ?? ""}\n\nChoose the runtime profile.`;
			const selected = await selectOne(
				flow,
				message,
				PROFILE_OPTIONS,
				initial,
				true,
				undefined,
				[settingsStatusToggleOption(toggleStatus, statusExpanded)],
			);
			if (selected === undefined) return undefined;
			if (selected === SETTINGS_STATUS_TOGGLE_VALUE) {
				statusExpanded = !statusExpanded;
				initial = SETTINGS_STATUS_TOGGLE_VALUE;
				continue;
			}
			return parseProfileAction(selected);
		}
	} finally {
		flow.end({ preserveDiagnostics: false });
	}
}

function currentProfileAction(config: ClankyConfig): ProfileAction {
	const conductorLocal = config.provider === "local";
	const voiceProvider = parseVoiceRealtimeProvider(config.voiceRealtimeProvider) ?? "openai";
	const voiceLocal = voiceProvider === "local";
	if (conductorLocal && voiceLocal) return isSingleLocalProfile(config) ? "local-single" : "local-tiered";
	if (conductorLocal) return "local-api";
	if (voiceLocal) return "api-local";
	return "api";
}

function isSingleLocalProfile(config: ClankyConfig): boolean {
	const localBaseUrl = config.localBaseUrl ?? DEFAULT_LOCAL_BASE_URL;
	const voiceBaseUrl = config.voiceLocalBaseUrl ?? config.localBaseUrl ?? DEFAULT_LOCAL_BASE_URL;
	const localModel = config.localModel ?? DEFAULT_LOCAL_CONDUCTOR_MODEL;
	const voiceModel = config.voiceRealtimeModel ?? DEFAULT_LOCAL_VOICE_LLM_MODEL;
	return voiceBaseUrl === localBaseUrl && voiceModel === localModel;
}

async function applyLocalProfile(
	profile: LocalProfile,
	config: ClankyConfig,
	voiceModelOverride: string | undefined,
): Promise<string> {
	// Drop bf16 for the conductor: it doubles memory bandwidth per token and roughly
	// halves throughput, which starves the concurrent voice/Discord agents on one GPU.
	const local = localProfileSettings(profile, config, voiceModelOverride);

	const updates: Record<string, string> = {
		CLANKY_MODEL_PROVIDER: "local",
		CLANKY_LOCAL_MODEL: local.conductorModel,
		CLANKY_LOCAL_BASE_URL: local.conductorBaseUrl,
		CLANKY_DISCORD_VOICE: "1",
		CLANKY_VOICE_REALTIME_PROVIDER: "local",
		CLANKY_VOICE_REALTIME_MODEL: local.voiceModel,
		CLANKY_VOICE_REALTIME_VOICE: config.voiceRealtimeVoice ?? DEFAULT_LOCAL_VOICE,
		CLANKY_VOICE_TTS_PROVIDER: "realtime",
		CLANKY_VOICE_ASR_MODEL: config.voiceAsrModel ?? defaultVoiceAsrModelPath(),
		CLANKY_VOICE_ASR_COMMAND: config.voiceAsrCommand ?? "whisper-cli",
		CLANKY_VOICE_LOCAL_BASE_URL: local.voiceBaseUrl,
		CLANKY_VOICE_LOCAL_TTS_ENGINE: config.voiceLocalTtsEngine ?? "say",
		CLANKY_VOICE_MEMORY_CONTEXT_LIMIT: config.voiceMemoryContextLimit ?? "16",
		CLANKY_VOICE_EVE_SESSION: config.voiceEveSession ?? "1",
	};
	await writeEnv(updates);

	const headline =
		profile === "local-tiered"
			? `Profile applied: local tiered; conductor ${local.conductorModel} @ ${local.conductorBaseUrl}, voice ${local.voiceModel} @ ${local.voiceBaseUrl}`
			: `Profile applied: local single; ${local.conductorModel} @ ${local.conductorBaseUrl} for conductor and voice`;
	const restarted = await restartBrainMessage(headline);
	const guidance = await buildLocalStackGuidance(profile, local.conductorModel, local.conductorBaseUrl, local.voiceModel, local.voiceBaseUrl);
	return `${restarted}\n\n${guidance}`;
}

function localProfileSettings(
	profile: LocalProfile,
	config: ClankyConfig,
	voiceModelOverride: string | undefined,
): { conductorModel: string; conductorBaseUrl: string; voiceModel: string; voiceBaseUrl: string } {
	const override = voiceModelOverride !== undefined && voiceModelOverride.length > 0 ? voiceModelOverride : undefined;
	let conductorModel = DEFAULT_LOCAL_CONDUCTOR_MODEL;
	if (profile === "local-single" && override !== undefined) {
		conductorModel = override;
	} else if (config.localModel !== undefined && config.localModel.length > 0 && !config.localModel.includes("bf16")) {
		conductorModel = config.localModel;
	}
	const conductorBaseUrl = config.localBaseUrl ?? DEFAULT_LOCAL_BASE_URL;
	const voiceModel =
		override !== undefined
			? override
			: profile === "local-single"
				? conductorModel
				: DEFAULT_LOCAL_VOICE_SMALL_MODEL;
	const voiceBaseUrl = profile === "local-single" ? conductorBaseUrl : DEFAULT_LOCAL_VOICE_SERVER_BASE_URL;
	return { conductorModel, conductorBaseUrl, voiceModel, voiceBaseUrl };
}

async function applyApiStackProfile(config: ClankyConfig): Promise<string> {
	const conductorProvider = apiConductorProvider(config);
	const voiceProvider = apiVoiceProvider(config);
	const voiceModel = defaultRealtimeModelForProvider(voiceProvider);
	const voice = defaultRealtimeVoiceForProvider(voiceProvider);
	const updates: Record<string, string> = {
		CLANKY_MODEL_PROVIDER: conductorProvider,
		CLANKY_DISCORD_VOICE: "1",
		CLANKY_VOICE_REALTIME_PROVIDER: voiceProvider,
		CLANKY_VOICE_REALTIME_MODEL: voiceModel,
		CLANKY_VOICE_REALTIME_VOICE: voice,
		CLANKY_VOICE_TTS_PROVIDER: "realtime",
	};
	await writeEnv(updates);

	const authHints = new Set<string>();
	const conductorHint = await modelRouteAuthHint(conductorProvider, false, config);
	if (conductorHint.length > 0) authHints.add(`Conductor: ${conductorHint.replace(/^ — /, "")}.`);
	if (voiceProvider === "openai" && config.openAiApiKeyPresent !== true) {
		authHints.add("Voice: run /auth openai to set CLANKY_OPENAI_API_KEY.");
	}
	if (voiceProvider === "xai" && config.xaiApiKeyPresent !== true) {
		authHints.add("Voice: run /auth xai to set CLANKY_XAI_API_KEY.");
	}

	const restarted = await restartBrainMessage(`API provider stack applied: conductor ${conductorProvider}, voice ${voiceProvider} realtime (${voiceModel})`);
	return authHints.size === 0 ? restarted : `${restarted}\n\n${[...authHints].join("\n")}`;
}

async function applyLocalApiProfile(config: ClankyConfig): Promise<string> {
	const local = localProfileSettings("local-single", config, undefined);
	const voiceProvider = apiVoiceProvider(config);
	const voiceModel = defaultRealtimeModelForProvider(voiceProvider);
	const voice = defaultRealtimeVoiceForProvider(voiceProvider);
	const updates: Record<string, string> = {
		CLANKY_MODEL_PROVIDER: "local",
		CLANKY_LOCAL_MODEL: local.conductorModel,
		CLANKY_LOCAL_BASE_URL: local.conductorBaseUrl,
		CLANKY_DISCORD_VOICE: "1",
		CLANKY_VOICE_REALTIME_PROVIDER: voiceProvider,
		CLANKY_VOICE_REALTIME_MODEL: voiceModel,
		CLANKY_VOICE_REALTIME_VOICE: voice,
		CLANKY_VOICE_TTS_PROVIDER: "realtime",
	};
	await writeEnv(updates);

	const authHints = voiceApiAuthHints(voiceProvider, config);
	const restarted = await restartBrainMessage(`Profile applied: local conductor + ${voiceProvider} voice API (${voiceModel})`);
	return authHints.length === 0 ? restarted : `${restarted}\n\n${authHints.join("\n")}`;
}

async function applyApiLocalProfile(config: ClankyConfig, voiceModelOverride: string | undefined): Promise<string> {
	const conductorProvider = apiConductorProvider(config);
	const voiceModel =
		voiceModelOverride !== undefined && voiceModelOverride.length > 0
			? voiceModelOverride
			: parseVoiceRealtimeProvider(config.voiceRealtimeProvider) === "local" && config.voiceRealtimeModel !== undefined
				? config.voiceRealtimeModel
				: DEFAULT_LOCAL_VOICE_SMALL_MODEL;
	const voiceBaseUrl = config.voiceLocalBaseUrl ?? DEFAULT_LOCAL_VOICE_SERVER_BASE_URL;
	const updates: Record<string, string> = {
		CLANKY_MODEL_PROVIDER: conductorProvider,
		CLANKY_DISCORD_VOICE: "1",
		CLANKY_VOICE_REALTIME_PROVIDER: "local",
		CLANKY_VOICE_REALTIME_MODEL: voiceModel,
		CLANKY_VOICE_REALTIME_VOICE: config.voiceRealtimeVoice ?? DEFAULT_LOCAL_VOICE,
		CLANKY_VOICE_TTS_PROVIDER: "realtime",
		CLANKY_VOICE_ASR_MODEL: config.voiceAsrModel ?? defaultVoiceAsrModelPath(),
		CLANKY_VOICE_ASR_COMMAND: config.voiceAsrCommand ?? "whisper-cli",
		CLANKY_VOICE_LOCAL_BASE_URL: voiceBaseUrl,
		CLANKY_VOICE_LOCAL_TTS_ENGINE: config.voiceLocalTtsEngine ?? "say",
		CLANKY_VOICE_MEMORY_CONTEXT_LIMIT: config.voiceMemoryContextLimit ?? "16",
		CLANKY_VOICE_EVE_SESSION: config.voiceEveSession ?? "1",
	};
	await writeEnv(updates);

	const authHints: string[] = [];
	const conductorHint = await modelRouteAuthHint(conductorProvider, false, config);
	if (conductorHint.length > 0) authHints.push(`Conductor: ${conductorHint.replace(/^ — /, "")}.`);
	const restarted = await restartBrainMessage(`Profile applied: ${conductorProvider} conductor + local voice ${voiceModel} @ ${voiceBaseUrl}`);
	return authHints.length === 0 ? restarted : `${restarted}\n\n${authHints.join("\n")}`;
}

function apiConductorProvider(config: ClankyConfig): ApiModelProvider {
	return config.provider === "local" ? "codex" : config.provider;
}

function apiVoiceProvider(config: ClankyConfig): ApiVoiceProvider {
	return parseVoiceRealtimeProvider(config.voiceRealtimeProvider) === "xai" ? "xai" : "openai";
}

function voiceApiAuthHints(provider: ApiVoiceProvider, config: ClankyConfig): string[] {
	if (provider === "openai" && config.openAiApiKeyPresent !== true) return ["Voice: run /auth openai to set CLANKY_OPENAI_API_KEY."];
	if (provider === "xai" && config.xaiApiKeyPresent !== true) return ["Voice: run /auth xai to set CLANKY_XAI_API_KEY."];
	return [];
}

async function buildLocalStackGuidance(
	profile: LocalProfile,
	conductorModel: string,
	conductorBaseUrl: string,
	voiceModel: string,
	voiceBaseUrl: string,
): Promise<string> {
	const lines: string[] = [];
	// Probe the running conductor endpoint; a shared-store second Ollama serves the
	// same models, so one check covers both the conductor and voice models.
	const installed = await fetchLocalModelIds(conductorBaseUrl);
	if (installed !== undefined) {
		const needed = profile === "local-tiered" ? [conductorModel, voiceModel] : [conductorModel];
		const missing = [...new Set(needed.filter((model) => !installed.includes(model)))];
		if (missing.length > 0) {
			lines.push("Pull missing models:");
			for (const model of missing) lines.push(`  ollama pull ${model}`);
			lines.push("");
		}
	}
	lines.push("Ollama daemon tuning (set once, then restart Ollama):");
	lines.push("  launchctl setenv OLLAMA_MAX_LOADED_MODELS 2");
	lines.push("  launchctl setenv OLLAMA_NUM_PARALLEL 3");
	lines.push("  launchctl setenv OLLAMA_KEEP_ALIVE -1");
	if (profile === "local-tiered") {
		const voicePort = (() => {
			try {
				return new URL(voiceBaseUrl).port || "11435";
			} catch {
				return "11435";
			}
		})();
		lines.push("");
		lines.push(`Run the separate voice server at ${voiceBaseUrl} (shares the model store):`);
		lines.push(`  OLLAMA_HOST=127.0.0.1:${voicePort} ollama serve`);
	}
	return lines.join("\n");
}

async function formatProfileStatus(config: ClankyConfig): Promise<string> {
	const localActive = config.provider === "local";
	const localModel = config.localModel ?? DEFAULT_LOCAL_MODEL;
	const localBaseUrl = config.localBaseUrl ?? DEFAULT_LOCAL_BASE_URL;
	const voiceProvider = parseVoiceRealtimeProvider(config.voiceRealtimeProvider) ?? "openai";
	const voiceModel = voiceRealtimeModelLabel(config, voiceProvider);
	const voiceBaseUrl = config.voiceLocalBaseUrl ?? config.localBaseUrl ?? DEFAULT_LOCAL_BASE_URL;
	const bf16Note = localModel.includes("bf16") ? "  [bf16 is heavy; /profile local-tiered switches to 4-bit]" : "";
	const voiceLines =
		voiceProvider === "local"
			? [
					statusLine("model", `${voiceModel} @ ${voiceBaseUrl}`, "ok"),
					statusLine("server", `${
						voiceBaseUrl !== localBaseUrl
							? "separate local server (isolated from local conductor turns)"
							: localActive
								? "shared with active local conductor"
								: "shared with standby local conductor endpoint"
					}`, voiceBaseUrl !== localBaseUrl || localActive ? "ok" : "muted"),
				]
			: [statusLine("model", voiceModel, "active"), statusLine("server", "hosted realtime provider", "active")];
	const lines = [
		statusTitle("Conductor"),
		statusLine("route", config.provider, localActive ? "ok" : "active"),
		statusLine("location", conductorLocation(config.provider), localActive ? "ok" : "active"),
		statusLine("model", `${activeConductorModel(config)}${localActive ? ` @ ${localBaseUrl}` : ""}`, "active"),
		"",
		// The local conductor fields persist regardless of route. When a hosted route is
		// live they describe the standby stack /profile local-tiered would activate, not anything
		// currently serving turns — label them so the two never read as contradictory.
		statusSection(localActive ? "Local conductor stack (active)" : "Local conductor stack (standby; run /profile local-tiered to activate)"),
		statusLine("conductor model", `${localModel} @ ${localBaseUrl}${bf16Note}`, localActive ? "ok" : "muted"),
		"",
		statusSection("Voice"),
		statusLine("provider", voiceProvider, voiceProvider === "local" ? "ok" : "active"),
		...voiceLines,
	];
	const installed = await fetchLocalModelIds(localBaseUrl);
	if (installed !== undefined) {
		lines.push(statusLine("installed models", installed.length === 0 ? "(none)" : installed.join(", "), installed.length === 0 ? "warn" : "muted"));
	} else {
		lines.push(statusLine("installed models", `(local endpoint ${localBaseUrl} unreachable)`, "warn"));
	}
	const ollamaEnv = ["OLLAMA_MAX_LOADED_MODELS", "OLLAMA_NUM_PARALLEL", "OLLAMA_KEEP_ALIVE"]
		.map((key) => `${key}=${process.env[key] ?? "(unset)"}`)
		.join("  ");
	lines.push(statusLine("ollama env (face process)", ollamaEnv, "muted"));
	return lines.join("\n");
}

function formatProfileSummary(config: ClankyConfig): string {
	const localActive = config.provider === "local";
	const localBaseUrl = config.localBaseUrl ?? DEFAULT_LOCAL_BASE_URL;
	const voiceProvider = parseVoiceRealtimeProvider(config.voiceRealtimeProvider) ?? "openai";
	const voiceTone = voiceProvider === "local" ? "ok" : "active";
	const lines = [
		statusTitle("Profile"),
		statusLine("conductor", formatProviderSummary(config), localActive ? "ok" : "active"),
		statusLine("voice", voiceModeLabel(voiceProvider), voiceTone),
	];
	if (localActive || voiceProvider === "local") {
		lines.push(statusLine("local endpoint", localBaseUrl, localActive ? "ok" : "muted"));
	} else {
		lines.push(statusLine("api mode", `${config.provider} conductor + ${voiceProvider} voice`, "active"));
	}
	return lines.join("\n");
}

function profileUsage(): string {
	return [
		"Usage:",
		"/profile status",
		"/profile local-tiered [voice-model]",
		"/profile local-single [model]",
		"/profile api",
		"/profile local-api",
		"/profile api-local [voice-model]",
	].join("\n");
}

async function fetchLocalModelIds(baseUrl: string): Promise<readonly string[] | undefined> {
	try {
		const response = await fetch(`${baseUrl.replace(/\/+$/, "")}/models`, { signal: AbortSignal.timeout(3000) });
		if (!response.ok) return undefined;
		const body = (await response.json()) as { data?: ReadonlyArray<{ id?: unknown }> };
		return (body.data ?? []).map((entry) => entry.id).filter((id): id is string => typeof id === "string" && id.length > 0);
	} catch {
		return undefined;
	}
}

type HarnessUpdate = {
	updates: Record<string, string>;
	removals?: readonly string[];
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
	await updateEnv(update.updates, update.removals ?? []);
	return await restartBrainMessage(`Coding harness updated: ${update.summary}`);
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
	const apply = async (update: HarnessInteractiveUpdate | string | undefined): Promise<string | undefined> => {
		if (update === undefined) return undefined;
		if (typeof update === "string") return update;
		await updateEnv(update.updates, update.removals ?? []);
		return await restartBrainMessage(update.message);
	};
	flow.begin("Configure coding harness");
	try {
		const result = await settingsLoop(flow, {
			title: "Choose the coding harness setting to change.",
			options: () => CODING_HARNESS_ACTION_OPTIONS,
			renderStatus: () => formatCodingHarnessMenuStatus(config),
			initial: "allow",
			dispatch: async (action) => {
				switch (action) {
					case "allow": {
						const selectedAllowedValues = await flow.readSelect({
							kind: "multi",
							message: "Toggle which coding harnesses Clanky may use for worker panes.",
							options: CODING_HARNESS_OPTIONS,
							initialValues: configuredAllowedHarnesses(config),
							required: true,
							allowBack: true,
						});
						if (selectedAllowedValues === undefined) return undefined;
						return await apply(buildHarnessAllowlistUpdate(config, selectedCodingHarnesses(selectedAllowedValues)));
					}
					case "launchers":
						return await apply(await promptHarnessLauncherUpdate(flow, config));
					case "custom":
						return await apply(await promptCustomHarnessUpdate(flow, config));
					default:
						return undefined;
				}
			},
		});
		return result ?? "/harness cancelled.";
	} finally {
		flow.end({ preserveDiagnostics: false });
	}
}

function buildHarnessAllowlistUpdate(
	config: ClankyConfig,
	allowed: readonly CodingHarnessId[] | undefined,
): HarnessInteractiveUpdate | string {
	if (allowed === undefined || allowed.length === 0) return "Harness allowlist must include at least one harness.";
	const updates: Record<string, string> = { [CLANKY_CODING_HARNESS_ENV.allowed]: allowed.join(",") };
	const removals = config.codingHarness === undefined ? [] : [CLANKY_CODING_HARNESS_ENV.id];
	const cleanupMessage = removals.length > 0 ? " Removed the obsolete fallback selection." : "";
	return {
		updates,
		removals,
		message: `Allowed coding harnesses set to ${allowed.join(", ")}.${cleanupMessage}`,
	};
}

async function promptHarnessLauncherUpdate(
	flow: SetupFlow,
	config: ClankyConfig,
): Promise<HarnessInteractiveUpdate | string | undefined> {
	const allowed = configuredAllowedHarnesses(config);
	const launchableOptions = CODING_HARNESS_OPTIONS.filter((option) => {
		const harness = parseLaunchableCodingHarnessId(option.value);
		return harness !== undefined && allowed.includes(harness);
	});
	if (launchableOptions.length === 0) {
		return "No launchable harnesses are allowed. Run /harness allow claude codex opencode to allow one.";
	}
	const selectedHarness = parseCodingHarnessId(
		await selectOne(
			flow,
			"Choose the harness launcher to configure.",
			launchableOptions,
			launchableOptions[0]?.value,
			true,
		),
	);
	if (selectedHarness === undefined) return undefined;

	const launchable = parseLaunchableCodingHarnessId(selectedHarness);
	if (launchable === undefined) return "Choose claude, codex, or opencode for launcher settings.";
	const tail: string[] = [];
	if (launchable !== undefined) {
		const env = codingHarnessEnv(config);
		const launcher = parseCodingHarnessLauncher(
			await selectOne(
				flow,
				`Choose the ${selectedHarness} launcher.`,
				CODING_HARNESS_LAUNCHER_OPTIONS,
				parseCodingHarnessLauncher(env[codingHarnessLauncherEnvKey(launchable)]) ?? "default",
				true,
			),
		);
		if (launcher === undefined) return undefined;
		tail.push(launcher);
		if (launcher === "ollama") {
			const model = await flow.readText({
				message: `Set the Ollama model for ${selectedHarness}.`,
				defaultValue: env[codingHarnessModelEnvKey(launchable)] ?? "",
				placeholder: "qwen3-coder:30b",
				allowBack: true,
			});
			if (model === undefined) return undefined;
			if (model.trim().length > 0) tail.push(model.trim());
		}
	}

	const result = buildHarnessUpdate(selectedHarness, tail, config);
	return typeof result === "string" ? result : { updates: result.updates, removals: result.removals, message: `Coding harness updated: ${result.summary}` };
}

async function promptCustomHarnessUpdate(
	flow: SetupFlow,
	config: ClankyConfig,
): Promise<HarnessInteractiveUpdate | string | undefined> {
	if (!configuredAllowedHarnesses(config).includes("custom")) {
		return "Custom coding harness is not allowed. Run /harness allow custom to allow it first.";
	}
	const runtime = parseCodingRuntime(
		await selectOne(flow, "Choose the custom harness runtime.", CODING_RUNTIME_OPTIONS, parseCodingRuntime(config.codingHarnessRuntime) ?? "native", true),
	);
	if (runtime === undefined) return undefined;
	const commandText = await flow.readText({
		message: "Set the custom coding harness command.",
		defaultValue: config.codingHarnessCommand ?? "",
		placeholder: "node worker.js",
		allowBack: true,
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
	return typeof result === "string" ? result : { updates: result.updates, removals: result.removals, message: `Coding harness updated: ${result.summary}` };
}

function selectedCodingHarnesses(values: readonly string[]): readonly CodingHarnessId[] {
	return values.map((value) => parseCodingHarnessId(value)).filter((value): value is CodingHarnessId => value !== undefined);
}

function buildHarnessUpdate(harness: CodingHarnessId, args: readonly string[], config: ClankyConfig): HarnessUpdate | string {
	const allowed = configuredAllowedHarnesses(config);
	if (!allowed.includes(harness)) {
		return `Coding harness '${harness}' is not allowed. Run /harness allow ${[...allowed, harness].join(" ")} to allow it.`;
	}
	const parsed = parseHarnessTail(args, harness !== "custom");
	if (typeof parsed === "string") return parsed;

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
				[CLANKY_CODING_HARNESS_ENV.command]: serializeCommandLine(command),
				[CLANKY_CODING_HARNESS_ENV.runtime]: resolved.runtime,
			},
			removals: [CLANKY_CODING_HARNESS_ENV.id],
			summary: formatCodingHarnessSummaryFromProfile(resolved),
		};
	}

	const launchable = parseLaunchableCodingHarnessId(harness);
	if (launchable === undefined) {
		if (args.length > 0) return harnessUsage();
		return `The ${harness} harness has no launcher settings. Use /spawn --harness ${harness} <slug> <task> to run it.`;
	}
	if (parsed.runtime !== undefined || parsed.command.length > 0) return harnessUsage();
	if (parsed.launcher === undefined && parsed.model === undefined) {
		const current = resolveCodingHarness({ harness, env: codingHarnessEnv(config) });
		return `Current ${harness} launcher: ${formatCodingHarnessLauncher(current)}\n\nUsage: /harness ${harness} [default|ollama] [ollama-model]`;
	}
	const updates: Record<string, string> = {};
	if (parsed.launcher !== undefined) updates[codingHarnessLauncherEnvKey(launchable)] = parsed.launcher;
	if (parsed.model !== undefined) updates[codingHarnessModelEnvKey(launchable)] = parsed.model;
	const resolved = resolveCodingHarness({ harness, env: { ...codingHarnessEnv(config), ...updates } });
	return {
		updates,
		removals: [CLANKY_CODING_HARNESS_ENV.id],
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
	return [
		statusTitle("Coding harnesses"),
		statusLine("allowed", allowed),
		statusLine("selection", "explicit per /spawn or herdr_spawn call", "active"),
		statusLine("custom command", formatCustomHarnessCommand(config), config.codingHarnessCommand === undefined ? "muted" : "normal"),
		"",
		statusSection("Configured worker launchers"),
		...formatCodingHarnessLauncherLines(config),
	].join("\n");
}

function formatCodingHarnessMenuStatus(config: ClankyConfig): SettingsMenuStatus {
	return collapsibleMenuStatus(
		[
			statusTitle("Harness"),
			statusLine("selection", "explicit per spawn", "active"),
			statusLine("allowed", formatAllowedHarnesses(config), "muted"),
		].join("\n"),
		formatCodingHarnessConfig(config),
	);
}

function formatCodingHarnessSummary(config: ClankyConfig): string {
	return `explicit selection; allowed ${formatAllowedHarnesses(config)}`;
}

function formatCustomHarnessCommand(config: ClankyConfig): string {
	try {
		const command = parseHarnessCommand(config.codingHarnessCommand);
		if (command === undefined || command.length === 0) return "(not configured)";
		const runtime = parseCodingRuntime(config.codingHarnessRuntime) ?? "native";
		return `${serializeCommandLine(command)} (runtime=${runtime})`;
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
		return statusLine(id, formatCodingHarnessLauncher(profile));
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
		"/harness claude [default|ollama] [ollama-model]",
		"/harness codex [default|ollama] [ollama-model]",
		"/harness opencode [default|ollama] [ollama-model]",
		"/harness <claude|codex|opencode> --launcher <default|ollama> --model <ollama-model>",
		"/harness custom <command...>",
		"/harness custom --runtime <clanky|native|opencode> <command...>",
		"Use /spawn --harness <clanky|claude|codex|opencode|custom> <slug> <task> to choose a worker for a run.",
		"Ollama codex workers use 'ollama launch codex', not the Codex desktop app.",
		"Ollama codex runs in an isolated CODEX_HOME (CLANKY_CODEX_OLLAMA_HOME) so it",
		"does not clobber a subscription codex worker's ~/.codex.",
		"Use {KICKOFF} where the task brief should be inserted; otherwise it is appended.",
	].join("\n");
}

async function configureEffort(argument: string, flow: SetupFlow | undefined): Promise<string> {
	const existing = await readConfig();
	const requested = splitArgs(argument)[0]?.toLowerCase();
	if (requested === "status" || requested === "show") return formatEffortStatus(existing);
	if (existing.provider === "claude") {
		return formatEffortStatus(existing);
	}
	if (existing.provider === "local") {
		let effort: string | undefined = requested;
		const isClear = (value: string | undefined): boolean => value === "unset" || value === "none" || value === "off";
		if (effort === undefined || (!isLocalEffortLevel(effort) && !isClear(effort))) {
			if (argument.trim().length > 0) return `Unknown local effort "${argument.trim()}". Use low, medium, high, or unset.`;
			if (flow === undefined) return `${formatEffortStatus(existing)}\n\nUsage: /effort [status|low|medium|high|unset]`;
			effort = await selectLocalEffort(flow, existing.localEffort, true);
			if (effort === "status") return formatEffortStatus(existing);
			if (effort === undefined || effort === "keep-current") return "/effort cancelled.";
		}
		if (isClear(effort)) {
			await removeEnv(["CLANKY_LOCAL_EFFORT"]);
			return await restartBrainMessage("Local reasoning effort cleared (uses the server default)");
		}
		await writeEnv({ CLANKY_LOCAL_EFFORT: effort });
		return await restartBrainMessage(`Local reasoning effort set to ${effort}`);
	}
	if (existing.provider !== "codex") {
		return formatEffortStatus(existing);
	}

	let effort: string | undefined = requested;
	if (effort === undefined || !isEffortLevel(effort)) {
		if (argument.trim().length > 0) return `Unknown Codex effort "${argument.trim()}".`;
		if (flow === undefined) return `${formatEffortStatus(existing)}\n\nUsage: /effort [status|minimal|low|medium|high|xhigh]`;
		effort = await selectEffort(flow, existing.codexEffort, true);
		if (effort === "status") return formatEffortStatus(existing);
		if (effort === undefined || effort === "keep-current") return "/effort cancelled.";
	}

	await writeEnv({ CLANKY_CODEX_EFFORT: effort });
	return await restartBrainMessage(`Codex reasoning effort set to ${effort}`);
}

function formatEffortStatus(config: ClankyConfig): string {
	if (config.provider === "claude") {
		return "Reasoning effort: not configurable for the active claude provider.";
	}
	if (config.provider === "xai" || config.provider === "gemini") {
		return `Reasoning effort: not configurable for the active ${config.provider} provider. Codex saved effort: ${config.codexEffort ?? "(backend default)"}. Local saved effort: ${config.localEffort ?? "(server default)"}.`;
	}
	if (config.provider === "local") {
		return `Local reasoning effort: ${config.localEffort ?? "(server default)"}. Usage: /effort [status|low|medium|high|unset]`;
	}
	return `Codex reasoning effort: ${config.codexEffort ?? "(backend default)"}. Usage: /effort [status|minimal|low|medium|high|xhigh]`;
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
		const config = await readConfig();
		const result = await settingsLoop(flow, {
			title: "Choose the approval mode.",
			options: () => APPROVAL_OPTIONS,
			renderStatus: () => formatApprovalsStatus(config),
			initial: isAutoApproveValue(config.autoApprove) ? "auto" : "prompt",
			dispatch: async (mode) => {
				if (mode !== "auto" && mode !== "prompt") return undefined;
				return await saveApprovalsMode(mode);
			},
		});
		return result ?? "/approvals cancelled.";
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

async function configureAgentMd(argument: string, flow: SetupFlow | undefined): Promise<string> {
	const args = splitArgs(argument);
	const command = args[0]?.toLowerCase();
	const config = await readConfig();
	if (command === undefined) {
		if (flow === undefined) return `${await formatAgentMdStatus(config)}\n\n${agentMdUsage()}`;
		return await configureAgentMdInteractive(flow, config);
	}
	if (command === "status" || command === "show") return await formatAgentMdStatus(config);
	if (command === "on" || command === "enable" || command === "enabled") {
		return await saveAgentMdMode(true, args.slice(1).join(" "));
	}
	if (command === "off" || command === "disable" || command === "disabled") {
		return await saveAgentMdMode(false);
	}
	if (command === "root") {
		const root = normalizeAgentMdRoot(args.slice(1).join(" "));
		if (root === undefined) return "Usage: /agent-md root <path>";
		await writeEnv({ [CLANKY_AGENT_MD_ROOT_ENV]: root });
		return await restartBrainMessage(`Agent file instruction root set to ${displayHomePath(root)}`);
	}
	if (command === "clear-root" || command === "unset-root") {
		await removeEnv([CLANKY_AGENT_MD_ROOT_ENV]);
		return await restartBrainMessage("Agent file instruction root cleared");
	}
	return `Unknown agent-md command "${command}".\n\n${agentMdUsage()}`;
}

async function configureAgentMdInteractive(flow: SetupFlow, config: ClankyConfig): Promise<string> {
	flow.begin("Configure agent file instructions");
	try {
		const result = await settingsLoop(flow, {
			title: "Choose AGENTS.md/agent.md ingestion setting.",
			options: () => AGENT_MD_OPTIONS,
			renderStatus: () => formatAgentMdMenuStatus(config),
			initial: agentMdEnabled(config) ? "on" : "off",
			dispatch: async (value) => {
				if (value === "on") return await saveAgentMdMode(true);
				if (value === "off") return await saveAgentMdMode(false);
				if (value === "clear-root") {
					await removeEnv([CLANKY_AGENT_MD_ROOT_ENV]);
					return await restartBrainMessage("Agent file instruction root cleared");
				}
				if (value !== "root") return undefined;
				const root = await flow.readText({
					message: "Set the AGENTS.md/agent.md scan start directory.",
					defaultValue: agentMdRoot(config),
					placeholder: agentMdRoot(config),
					validate: validateAgentMdRootText,
					allowBack: true,
				});
				const normalized = normalizeAgentMdRoot(root);
				if (normalized === undefined) return undefined;
				await writeEnv({ [CLANKY_AGENT_MD_ROOT_ENV]: normalized });
				return await restartBrainMessage(`Agent file instruction root set to ${displayHomePath(normalized)}`);
			},
		});
		return result ?? "/agent-md cancelled.";
	} finally {
		flow.end({ preserveDiagnostics: false });
	}
}

async function saveAgentMdMode(enabled: boolean, rootArgument = ""): Promise<string> {
	const updates: Record<string, string> = { [CLANKY_AGENT_MD_ENV]: enabled ? "1" : "0" };
	const root = normalizeAgentMdRoot(rootArgument);
	if (root !== undefined) updates[CLANKY_AGENT_MD_ROOT_ENV] = root;
	const rootSummary = root === undefined ? "" : ` from ${displayHomePath(root)}`;
	await writeEnv(updates);
	return await restartBrainMessage(`Agent file instruction ingestion ${enabled ? "enabled" : "disabled"}${rootSummary}`);
}

function agentMdEnabled(config: ClankyConfig): boolean {
	return parseAgentMdToggle(config.agentMd) === true;
}

function agentMdRoot(config: ClankyConfig): string {
	const configured = config.agentMdRoot?.trim();
	return configured !== undefined && configured.length > 0 ? configured : REPO;
}

function formatAgentMdSummary(config: ClankyConfig): string {
	return agentMdEnabled(config) ? `on (${displayHomePath(agentMdRoot(config))})` : "off";
}

function normalizeAgentMdRoot(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	if (trimmed === undefined || trimmed.length === 0) return undefined;
	return resolve(REPO, trimmed.replace(/^~(?=\/|$)/u, process.env.HOME ?? "~"));
}

function validateAgentMdRootText(value: string): string | undefined {
	return normalizeAgentMdRoot(value) === undefined ? "Enter a scan start directory." : undefined;
}

async function formatAgentMdStatus(config: ClankyConfig): Promise<string> {
	const enabled = agentMdEnabled(config);
	const root = agentMdRoot(config);
	const files = enabled ? await collectAgentMdFiles({ root }) : [];
	const matched = enabled
		? files.length === 0
			? "(none)"
			: files.map((file) => displayHomePath(file.path)).join(", ")
		: "(disabled)";
	return [
		statusTitle("Agent file instructions"),
		statusLine("ingestion", enabled ? "on" : "off", enabled ? "active" : "muted"),
		statusLine("root", displayHomePath(root), "muted"),
		statusLine("filenames", AGENT_MD_FILENAMES.join(", "), "muted"),
		statusLine("matched", matched, enabled && files.length > 0 ? "ok" : "muted"),
		ansi.dim("Usage: /agent-md [on|off|status|root <path>|clear-root]"),
	].join("\n");
}

function formatAgentMdMenuStatus(config: ClankyConfig): SettingsMenuStatus {
	const enabled = agentMdEnabled(config);
	const root = displayHomePath(agentMdRoot(config));
	const collapsed = [
		statusTitle("Agent files"),
		statusLine("ingestion", enabled ? "on" : "off", enabled ? "active" : "muted"),
		statusLine("root", root, "muted"),
	].join("\n");
	const expanded = [
		collapsed,
		statusLine("filenames", AGENT_MD_FILENAMES.join(", "), "muted"),
		statusLine("order", "parent directories before leaf directories", "muted"),
		ansi.dim("Use /agent-md status to list matched files."),
	].join("\n");
	return collapsibleMenuStatus(collapsed, expanded);
}

function agentMdUsage(): string {
	return [
		"Usage:",
		"/agent-md",
		"/agent-md status",
		"/agent-md on [root]",
		"/agent-md off",
		"/agent-md root <path>",
		"/agent-md clear-root",
	].join("\n");
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
		const result = await settingsLoop(flow, {
			title: "Choose the compact turn trace mode.",
			options: () => TRACE_OPTIONS,
			renderStatus: () => formatTraceStatus(),
			initial: turnTraceMode,
			dispatch: async (selected) => {
				const mode = parseTurnTraceMode(selected);
				if (mode === undefined) return undefined;
				turnTraceMode = mode;
				return formatTraceStatus();
			},
		});
		return result ?? "/trace cancelled.";
	} finally {
		flow.end({ preserveDiagnostics: false });
	}
}

function formatTraceStatus(): string {
	const state = session.state;
	const sessionStatus =
		state.sessionId === undefined ? "session none" : `session ${state.sessionId}; stream index ${state.streamIndex}`;
	return `Turn trace: ${turnTraceMode}. ${sessionStatus}. Use /trace off|no-reply|all.`;
}

async function configureLayout(argument: string, flow: SetupFlow | undefined): Promise<string> {
	const args = splitArgs(argument).map((part) => part.toLowerCase());
	const first = args[0];
	if (first === undefined) {
		if (flow === undefined) return formatLayoutStatus();
		return await configureLayoutInteractive(flow);
	}
	if (first === "show" || (first === "status" && args.length === 1)) return formatLayoutStatus();
	if (first === "input" || first === "chat" || first === "prompt") {
		const placement = parseInputPlacement(args[1]);
		if (placement === undefined) return "Usage: /layout input <top|bottom>";
		return await saveInputPlacement(placement);
	}
	if (first === "top" || first === "bottom") return await saveInputPlacement(first);
	if (first === "status" || first === "footer" || first === "bar") {
		const placement = parseStatusPlacement(args[1]);
		if (placement === undefined) return "Usage: /layout status <above|below>";
		return await saveStatusPlacement(placement);
	}
	if (first === "spinner-rate" || first === "spinner-cycle-rate" || first === "rate") return await configureAgentSpinnerCycleRate(args[1]);
	if (first === "spinner" || first === "spinners" || first === "loader") {
		if (args[1] === "rate" || args[1] === "cycle-rate" || args[1] === "speed") return await configureAgentSpinnerCycleRate(args[2]);
		const spinner = parseLayoutSpinnerSelection(args.slice(1));
		if (spinner === undefined) return formatAgentSpinnerUsage(args[1]);
		return await saveAgentSpinner(spinner);
	}
	if (first === "header" || first === "banner") return await configureHeader(args.slice(1).join(" "));
	return `Unknown layout setting "${first}". Use /layout status, /layout input top|bottom, /layout status above|below, /layout spinner <name>, /layout spinner rate <ms>, or /layout header on|off.`;
}

async function configureLayoutInteractive(flow: SetupFlow): Promise<string> {
	flow.begin("Configure layout");
	try {
		const result = await settingsLoop(flow, {
			title: "Choose layout.",
			options: () => LAYOUT_OPTIONS,
			renderStatus: () => formatLayoutStatus(),
			initial: "input",
			dispatch: async (setting) => {
				if (setting === "input") {
					const selected = parseInputPlacement(await selectOne(flow, "Place the chat input.", LAYOUT_INPUT_OPTIONS, layoutSettings.inputPlacement, true, layoutSettings.inputPlacement));
					return selected === undefined ? undefined : await saveInputPlacement(selected);
				}
				if (setting === "status") {
					const selected = parseStatusPlacement(await selectOne(flow, "Place the status bar relative to the input.", LAYOUT_STATUS_OPTIONS, layoutSettings.statusPlacement, true, layoutSettings.statusPlacement));
					return selected === undefined ? undefined : await saveStatusPlacement(selected);
				}
				if (setting === "spinner") {
					const selected = normalizeAgentSpinnerSelection(await selectOne(flow, "Choose the thinking spinner.", agentSpinnerOptions(), agentSpinner.name, true, agentSpinner.name));
					return selected === undefined ? undefined : await saveAgentSpinner(selected);
				}
				if (setting === "spinner-rate") return await configureAgentSpinnerCycleRateInteractive(flow);
				if (setting === "header") {
					const current = headerVisible ? "on" : "off";
					const selected = parseBooleanFlag(await selectOne(flow, "Show the sticky header.", LAYOUT_HEADER_OPTIONS, current, true, current));
					return selected === undefined ? undefined : await saveHeaderVisible(selected);
				}
				return undefined;
			},
		});
		return result ?? "/layout cancelled.";
	} finally {
		flow.end({ preserveDiagnostics: false });
	}
}

function parseLayoutSpinnerSelection(args: readonly string[]): AgentSpinnerSelection | undefined {
	const first = args[0];
	if (first === "custom") return normalizeAgentSpinnerSelection(`custom:${args.slice(1).join(",")}`);
	if (first === "cycle" && args.length > 1) return normalizeAgentSpinnerSelection(`custom:${args.slice(1).join(",")}`);
	if (first === "preset") return normalizeAgentSpinnerSelection(args[1]);
	if (args.length > 1) return normalizeAgentSpinnerSelection(`custom:${args.join(",")}`);
	return normalizeAgentSpinnerSelection(first);
}

async function configureHeader(argument: string): Promise<string> {
	const mode = argument.trim().toLowerCase();
	if (mode === "status" || mode === "show") return formatHeaderStatus();
	if (mode.length === 0 || mode === "toggle") {
		return await saveHeaderVisible(!headerVisible);
	}
	const next = parseBooleanFlag(mode);
	if (next === undefined) return `Unknown header mode "${argument}". Use /header on|off|toggle|status.`;
	return await saveHeaderVisible(next);
}

async function saveHeaderVisible(next: boolean): Promise<string> {
	await writeEnv({ CLANKY_HEADER: next ? "1" : "0" });
	applyHeaderVisible(next);
	return formatHeaderStatus();
}

function applyHeaderVisible(visible: boolean): void {
	headerVisible = visible;
	banner.setVisible(visible);
	refreshStatusView();
}

function formatHeaderStatus(): string {
	return `Header: ${headerVisible ? "on" : "off"}. Use /layout header on|off|toggle|status.`;
}

async function saveInputPlacement(placement: InputPlacement): Promise<string> {
	layoutSettings = { ...layoutSettings, inputPlacement: placement };
	await writeEnv({ [CLANKY_TUI_INPUT_PLACEMENT_ENV]: placement });
	applyFaceLayout();
	return formatLayoutStatus();
}

async function saveStatusPlacement(placement: StatusPlacement): Promise<string> {
	layoutSettings = { ...layoutSettings, statusPlacement: placement };
	await writeEnv({ [CLANKY_TUI_STATUS_PLACEMENT_ENV]: placement });
	applyFaceLayout();
	return formatLayoutStatus();
}

async function saveAgentSpinner(name: AgentSpinnerSelection): Promise<string> {
	agentSpinner = resolveAgentSpinner(name, { unicode: faceCapabilities.unicode, cycleDwellMs: agentSpinnerCycleRateMs });
	await writeEnv({ [CLANKY_TUI_SPINNER_ENV]: agentSpinner.name });
	activeLoader?.setIndicator(loaderIndicatorFor(agentSpinner));
	refreshStatusView();
	return formatAgentSpinnerStatus();
}

async function configureAgentSpinnerCycleRate(value: string | undefined): Promise<string> {
	const normalized = value?.trim().toLowerCase();
	if (normalized === undefined || normalized.length === 0 || normalized === "status" || normalized === "show") return formatAgentSpinnerCycleRateStatus();
	const next = parseAgentSpinnerCycleRateMs(value);
	if (next === undefined) return formatAgentSpinnerCycleRateUsage(value);
	return await saveAgentSpinnerCycleRate(next);
}

async function configureAgentSpinnerCycleRateInteractive(flow: SetupFlow): Promise<string | undefined> {
	const selected = await flow.readText({
		allowBack: true,
		defaultValue: `${agentSpinnerCycleRateMs}`,
		message: "Set spinner cycle rate in ms per style.",
		placeholder: "fast, normal, slow, 400, 400ms, or 1.2s",
		validate: (value) => parseAgentSpinnerCycleRateMs(value) === undefined ? formatAgentSpinnerCycleRateUsage(value) : undefined,
	});
	if (selected === undefined) return undefined;
	const next = parseAgentSpinnerCycleRateMs(selected);
	return next === undefined ? formatAgentSpinnerCycleRateUsage(selected) : await saveAgentSpinnerCycleRate(next);
}

async function saveAgentSpinnerCycleRate(next: number): Promise<string> {
	agentSpinnerCycleRateMs = next;
	agentSpinner = resolveAgentSpinner(agentSpinner.name, { unicode: faceCapabilities.unicode, cycleDwellMs: agentSpinnerCycleRateMs });
	await writeEnv({ [CLANKY_TUI_SPINNER_RATE_MS_ENV]: String(agentSpinnerCycleRateMs) });
	activeLoader?.setIndicator(loaderIndicatorFor(agentSpinner));
	refreshStatusView();
	return formatAgentSpinnerStatus();
}

function agentSpinnerOptions(): readonly MenuOption[] {
	return [AGENT_SPINNER_CYCLE_NAME, ...AGENT_SPINNER_PRESET_NAMES, ...AGENT_SPINNER_NAMES].map((name) => ({
		value: name,
		label: formatAgentSpinnerOptionLabel(name),
		hint: name === agentSpinner.name ? "active" : agentSpinnerOptionHint(name),
	}));
}

function formatAgentSpinnerOptionLabel(name: string): string {
	if (name.startsWith("width-")) return `width: ${name.replace(/^width-/u, "")}`;
	return name;
}

function agentSpinnerOptionHint(name: string): string | undefined {
	if (name === AGENT_SPINNER_CYCLE_NAME) return "rotate through all";
	if (name in AGENT_SPINNER_PRESETS) return `cycle ${AGENT_SPINNER_PRESETS[name as keyof typeof AGENT_SPINNER_PRESETS].length} same-width spinners`;
	return undefined;
}

function formatAgentSpinnerStatus(): string {
	return [
		statusTitle("Spinner"),
		statusLine("active", agentSpinner.name, "active"),
		statusLine("cycle rate", `${agentSpinnerCycleRateMs}ms/style`, "active"),
		statusLine("source", "expo-agent-spinners", "muted"),
		ansi.dim(`Usage: /layout spinner <name|preset|custom names...>; /layout spinner rate <fast|normal|slow|ms>. Custom: /layout spinner custom dots dots2 dots9. Available: ${agentSpinnerAvailableValues().join(", ")}`),
	].join("\n");
}

function formatAgentSpinnerCycleRateStatus(): string {
	return `Spinner cycle rate: ${agentSpinnerCycleRateMs}ms per style. Use /layout spinner rate fast|normal|slow|<ms>.`;
}

function formatAgentSpinnerCycleRateUsage(value: string | undefined): string {
	const prefix = value === undefined ? "Usage: /layout spinner rate <fast|normal|slow|ms>." : `Unknown spinner cycle rate "${value}".`;
	return `${prefix} Use a positive millisecond value, e.g. 40, 800ms, or 12s.`;
}

function formatAgentSpinnerUsage(value: string | undefined): string {
	const prefix = value === undefined ? "Usage: /layout spinner <name|preset|custom names...>." : `Unknown spinner "${value}".`;
	return `${prefix} Use width-1, micro, one spinner name, or custom dots dots2 dots9. Available: ${agentSpinnerAvailableValues().join(", ")}`;
}

function agentSpinnerAvailableValues(): readonly string[] {
	return [AGENT_SPINNER_CYCLE_NAME, ...AGENT_SPINNER_PRESET_NAMES, ...AGENT_SPINNER_NAMES];
}

function loaderIndicatorFor(spinner: ResolvedAgentSpinner): { frames: string[]; intervalMs: number } {
	return {
		frames: spinner.frames.map((frame) => ansi.cyan(frame)),
		intervalMs: spinner.intervalMs,
	};
}

function formatLayoutStatus(): string {
	const statusPlacement = layoutSettings.statusPlacement === "above-input" ? "above input" : "below input";
	const typeaheadPlacement = layoutSettings.inputPlacement === "top" ? "below status/input pair" : "above status/input pair";
	return [
		statusTitle("Layout"),
		statusLine("input", layoutSettings.inputPlacement, "active"),
		statusLine("status", statusPlacement, "active"),
		statusLine("spinner", agentSpinner.name, "active"),
		statusLine("spinner rate", `${agentSpinnerCycleRateMs}ms/style`, "active"),
		statusLine("typeahead", typeaheadPlacement, "muted"),
		statusLine("header", headerVisible ? "on" : "off", headerVisible ? "ok" : "muted"),
		ansi.dim("Usage: /layout [status|input top|bottom|status above|below|spinner <name|preset|custom names...>|spinner rate <ms>|header on|off]"),
	].join("\n");
}

function parseImageProvider(value: string | undefined): ImageProvider | undefined {
	return value === "openai" || value === "xai" || value === "gemini" ? value : undefined;
}

function currentImageProvider(config: ClankyConfig): ImageProvider {
	return parseImageProvider(config.imageProvider) ?? "openai";
}

function imageModelFor(config: ClankyConfig, provider: ImageProvider): string {
	const configured = (provider === "openai" ? config.imageModel : provider === "xai" ? config.xaiImageModel : config.geminiImageModel)?.trim();
	return configured !== undefined && configured.length > 0 ? configured : IMAGE_MODEL_DEFAULT[provider];
}

async function configureImageModel(argument: string, flow: SetupFlow | undefined): Promise<string> {
	const args = splitArgs(argument);
	const first = args[0]?.toLowerCase();
	const config = await readConfig();
	if (first === "status" || first === "show") return formatImageModelStatus(config);
	if (first === "unset" || first === "clear" || first === "default" || first === "none" || first === "off") {
		await removeEnv(["CLANKY_OPENAI_IMAGE_MODEL", "CLANKY_XAI_IMAGE_MODEL", "CLANKY_GEMINI_IMAGE_MODEL", "CLANKY_IMAGE_PROVIDER"]);
		return await restartBrainMessage("Image model overrides cleared");
	}
	const provider = parseImageProvider(first);
	if (provider !== undefined) return await saveImageModel(provider, args.slice(1).join(" ").trim());
	if (argument.trim().length > 0) return await saveImageModel(currentImageProvider(config), argument.trim());
	if (flow === undefined) return `${formatImageModelStatus(config)}\n\n${imageModelUsage()}`;
	return await configureImageModelInteractive(flow, config);
}

async function saveImageModel(provider: ImageProvider, model: string): Promise<string> {
	const updates: Record<string, string> = { CLANKY_IMAGE_PROVIDER: provider };
	if (model.length > 0) updates[IMAGE_MODEL_ENV[provider]] = model;
	await writeEnv(updates);
	return await restartBrainMessage(`Image provider set to ${provider}${model.length > 0 ? ` (${model})` : ""}`);
}

async function configureImageModelInteractive(flow: SetupFlow, config: ClankyConfig): Promise<string> {
	flow.begin("Select image model");
	try {
		const result = await settingsLoop(flow, {
			title: "Select the image generation provider.",
			options: () => IMAGE_PROVIDER_OPTIONS,
			renderStatus: () => formatImageModelMenuStatus(config),
			initial: currentImageProvider(config),
			dispatch: async (providerChoice) => {
				const provider = parseImageProvider(providerChoice);
				if (provider === undefined) return undefined;
				const selected = await selectOne(flow, `Select the ${provider} image model.`, IMAGE_MODEL_OPTIONS[provider], imageModelFor(config, provider), true);
				if (selected === undefined) return undefined;
				const rawModel =
					selected === ENTER_IMAGE_MODEL_OPTION
						? await flow.readText({
								message: `Enter a ${provider} image model id.`,
								placeholder: imageModelFor(config, provider),
								validate: requiredImageModelText,
								allowBack: true,
							})
						: selected;
				if (rawModel === undefined) return undefined;
				const model = rawModel.trim();
				await writeEnv({ CLANKY_IMAGE_PROVIDER: provider, [IMAGE_MODEL_ENV[provider]]: model });
				return await restartBrainMessage(`Image provider set to ${provider} (${model})`);
			},
		});
		return result ?? "/image-model cancelled.";
	} finally {
		flow.end({ preserveDiagnostics: false });
	}
}

function formatImageModelStatus(config: ClankyConfig): string {
	const provider = currentImageProvider(config);
	return [
		statusTitle("Image generation"),
		statusLine("active provider", provider, "active"),
		statusLine("active model", imageModelFor(config, provider), "active"),
		"",
		statusSection("Provider model settings"),
		statusLine("openai", imageModelFor(config, "openai"), provider === "openai" ? "active" : "muted"),
		statusLine("xai", imageModelFor(config, "xai"), provider === "xai" ? "active" : "muted"),
		statusLine("gemini", imageModelFor(config, "gemini"), provider === "gemini" ? "active" : "muted"),
	].join("\n");
}

function formatImageModelMenuStatus(config: ClankyConfig): SettingsMenuStatus {
	const provider = currentImageProvider(config);
	return collapsibleMenuStatus(`${statusTitle("Image")}\n${statusLine(provider, imageModelFor(config, provider), "active")}`, formatImageModelStatus(config));
}

function imageModelUsage(): string {
	return [
		"Usage:",
		"/image-model                      interactive (provider then model)",
		"/image-model status",
		"/image-model openai <model-id>",
		"/image-model xai <model-id>",
		"/image-model gemini <model-id>",
		"/image-model unset",
	].join("\n");
}

function currentImageModel(config: ClankyConfig): string {
	return imageModelFor(config, currentImageProvider(config));
}

function currentVideoModel(config: ClankyConfig): string {
	const configured = config.xaiVideoModel?.trim();
	return configured !== undefined && configured.length > 0 ? configured : DEFAULT_XAI_VIDEO_MODEL;
}

async function configureVideoModel(argument: string, flow: SetupFlow | undefined): Promise<string> {
	const args = splitArgs(argument);
	const first = args[0]?.toLowerCase();
	const config = await readConfig();
	if (first === "status" || first === "show") return formatVideoModelStatus(config);
	if (first === "unset" || first === "clear" || first === "default" || first === "none" || first === "off") {
		await removeEnv(["CLANKY_XAI_VIDEO_MODEL", "CLANKY_VIDEO_PROVIDER"]);
		return await restartBrainMessage("Video model overrides cleared");
	}
	// xAI is the only video provider; accept an optional leading "xai" token.
	const model = (first === "xai" ? args.slice(1).join(" ") : argument).trim();
	if (model.length > 0) return await saveVideoModel(model);
	if (flow === undefined) return `${formatVideoModelStatus(config)}\n\n${videoModelUsage()}`;
	return await configureVideoModelInteractive(flow, config);
}

async function saveVideoModel(model: string): Promise<string> {
	await writeEnv({ CLANKY_VIDEO_PROVIDER: "xai", CLANKY_XAI_VIDEO_MODEL: model });
	return await restartBrainMessage(`Video model set to xai (${model})`);
}

async function configureVideoModelInteractive(flow: SetupFlow, config: ClankyConfig): Promise<string> {
	flow.begin("Select video model");
	try {
		const result = await settingsLoop(flow, {
			title: "Select the xAI video model.",
			options: () => VIDEO_MODEL_OPTIONS,
			renderStatus: () => formatVideoModelMenuStatus(config),
			initial: currentVideoModel(config),
			dispatch: async (selected) => {
				const rawModel =
					selected === ENTER_IMAGE_MODEL_OPTION
						? await flow.readText({ message: "Enter an xAI video model id.", placeholder: currentVideoModel(config), validate: requiredImageModelText, allowBack: true })
						: selected;
				if (rawModel === undefined) return undefined;
				const chosen = rawModel.trim();
				if (chosen.length === 0) return undefined;
				return await saveVideoModel(chosen);
			},
		});
		return result ?? "/video-model cancelled.";
	} finally {
		flow.end({ preserveDiagnostics: false });
	}
}

function formatVideoModelStatus(config: ClankyConfig): string {
	return [statusTitle("Video generation"), statusLine("active provider", "xai", "active"), statusLine("active model", currentVideoModel(config), "active")].join("\n");
}

function formatVideoModelMenuStatus(config: ClankyConfig): SettingsMenuStatus {
	return collapsibleMenuStatus(`${statusTitle("Video")}\n${statusLine("xai", currentVideoModel(config), "active")}`, formatVideoModelStatus(config));
}

function videoModelUsage(): string {
	return ["Usage:", "/video-model", "/video-model status", "/video-model xai <model-id>", "/video-model <model-id>", "/video-model unset"].join("\n");
}

async function configureVisionModel(argument: string, flow: SetupFlow | undefined): Promise<string> {
	const args = splitArgs(argument);
	const first = args[0]?.toLowerCase();
	const config = await readConfig();
	if (first === "status" || first === "show") return formatVisionModelStatus(config);
	if (first === "unset" || first === "clear" || first === "default" || first === "none") {
		await removeEnv(["CLANKY_VISION_MODEL", "CLANKY_VISION_ENABLED", "CLANKY_VISION_PROVIDER", "CLANKY_VISION_BASE_URL"]);
		return await restartBrainMessage("Vision override cleared; image inspection uses the brain model");
	}
	if (first === "on" || first === "enable") {
		if (config.visionModel === undefined || config.visionModel.length === 0) {
			return "No vision model selected. Set one first: /vision-model <model-id>";
		}
		await writeEnv({ CLANKY_VISION_ENABLED: "1" });
		return await restartBrainMessage(`Vision override on (${config.visionModel})`);
	}
	if (first === "off" || first === "disable") {
		await writeEnv({ CLANKY_VISION_ENABLED: "0" });
		return await restartBrainMessage("Vision override off; image inspection uses the brain model");
	}
	if (first === "openai") return await saveOpenAiVisionModel(args.slice(1).join(" "));
	if (first === "local") return await selectVisionModel(args.slice(1).join(" "), "local");
	if (first === "ollama") return await selectVisionModel(args.slice(1).join(" "), "ollama");
	if (first === "codex" || first === "claude") return await selectVisionModel(args.slice(1).join(" "), first);
	if (argument.trim().length > 0) return await selectVisionModel(argument, "local");
	if (flow === undefined) return `${formatVisionModelStatus(config)}\n\n${visionModelUsage()}`;
	return await configureVisionModelInteractive(flow, config);
}

async function configureVisionModelInteractive(flow: SetupFlow, config: ClankyConfig): Promise<string> {
	const apply = async (update: { updates?: Record<string, string>; removals?: string[]; message: string }): Promise<string> => {
		if (update.removals !== undefined) await removeEnv(update.removals);
		if (update.updates !== undefined) await writeEnv(update.updates);
		return await restartBrainMessage(update.message);
	};
	flow.begin("Configure vision model");
	try {
		const result = await settingsLoop(flow, {
			title: "Choose the vision setting to change.",
			options: () => [
				{ value: "select", label: "select vision model", hint: config.visionModel ?? "dedicated model (e.g. qwen3-vl:32b)" },
				{ value: "on", label: "turn override on", hint: "use the selected vision model" },
				{ value: "off", label: "turn override off", hint: "use the brain model for vision" },
				{ value: "openai", label: "OpenAI fallback model", hint: config.openAiVisionModel ?? "gpt-5.4-mini" },
				{ value: "clear", label: "clear override", hint: "remove the dedicated vision model" },
			],
			renderStatus: () => formatVisionModelMenuStatus(config),
			dispatch: async (action) => {
				if (action === "on") {
					if (config.visionModel === undefined || config.visionModel.length === 0) return "No vision model selected. Choose 'select vision model' first.";
					return await apply({ updates: { CLANKY_VISION_ENABLED: "1" }, message: `Vision override on (${config.visionModel})` });
				}
				if (action === "off") {
					return await apply({ updates: { CLANKY_VISION_ENABLED: "0" }, message: "Vision override off; image inspection uses the brain model" });
				}
				if (action === "clear") {
					return await apply({
						removals: ["CLANKY_VISION_MODEL", "CLANKY_VISION_ENABLED", "CLANKY_VISION_PROVIDER", "CLANKY_VISION_BASE_URL"],
						message: "Vision override cleared; image inspection uses the brain model",
					});
				}
				const current = action === "openai" ? config.openAiVisionModel : config.visionModel;
				const value = await flow.readText({
					message: action === "openai" ? "Set the OpenAI fallback vision model." : "Select the dedicated vision model for media_inspect.",
					defaultValue: current ?? "",
					placeholder: action === "openai" ? "gpt-5.4-mini" : "qwen3-vl:32b",
					validate: requiredVisionModelText,
					allowBack: true,
				});
				if (value === undefined) return undefined;
				const model = value.trim();
				return action === "openai"
					? await apply({ updates: { CLANKY_OPENAI_VISION_MODEL: model }, message: `OpenAI fallback vision model set to ${model}` })
					: await apply({ updates: { CLANKY_VISION_MODEL: model, CLANKY_VISION_ENABLED: "1" }, message: `Vision model set to ${model} and override turned on` });
			},
		});
		return result ?? "/vision-model cancelled.";
	} finally {
		flow.end({ preserveDiagnostics: false });
	}
}

async function selectVisionModel(rawModel: string, provider: "local" | "ollama" | "codex" | "claude"): Promise<string> {
	const model = rawModel.trim();
	if (model.length === 0) return "Usage: /vision-model <model-id> or /vision-model unset";
	const updates: Record<string, string> = { CLANKY_VISION_MODEL: model, CLANKY_VISION_ENABLED: "1" };
	if (provider !== "local") updates.CLANKY_VISION_PROVIDER = provider;
	await writeEnv(updates);
	return await restartBrainMessage(`Vision model set to ${model} (${provider}) and override turned on`);
}

async function saveOpenAiVisionModel(rawModel: string): Promise<string> {
	const model = rawModel.trim();
	if (model.length === 0) return "Usage: /vision-model openai <model-id>";
	await writeEnv({ CLANKY_OPENAI_VISION_MODEL: model });
	return await restartBrainMessage(`OpenAI fallback vision model set to ${model}`);
}

function formatVisionModelStatus(config: ClankyConfig): string {
	const enabled = isTruthyEnvValue(config.visionEnabled);
	const selected = config.visionModel ?? "(none)";
	const provider = config.visionProvider ?? "local";
	return [
		statusTitle("Vision inspection"),
		statusLine("override", enabled ? "on" : "off", enabled ? "ok" : "muted"),
		statusLine("selected override model", `${selected}${config.visionModel === undefined ? "" : ` (${provider})`}`, enabled ? "active" : "muted"),
		statusLine("active when off", "brain model", enabled ? "muted" : "active"),
		statusLine("OpenAI fallback vision model", config.openAiVisionModel ?? "gpt-5.4-mini"),
	].join("\n");
}

function formatVisionModelMenuStatus(config: ClankyConfig): SettingsMenuStatus {
	const enabled = isTruthyEnvValue(config.visionEnabled);
	const active = enabled ? `override ${config.visionModel ?? "(none)"}` : "brain model";
	return collapsibleMenuStatus(
		[
			statusTitle("Vision"),
			statusLine("active", active, enabled ? "active" : "ok"),
			statusLine("OpenAI fallback", config.openAiVisionModel ?? "gpt-5.4-mini", "muted"),
		].join("\n"),
		formatVisionModelStatus(config),
	);
}

function isTruthyEnvValue(value: string | undefined): boolean {
	if (value === undefined) return false;
	return ["1", "on", "true", "yes"].includes(value.trim().toLowerCase());
}

function visionModelUsage(): string {
	return [
		"Usage:",
		"/vision-model                       interactive",
		"/vision-model status",
		"/vision-model <model-id>            select a local model and turn override on",
		"/vision-model ollama <model-id>     select a model on the Ollama endpoint",
		"/vision-model codex|claude <model>  select a hosted vision model",
		"/vision-model on | off              toggle the selected override",
		"/vision-model openai <model-id>     set the OpenAI fallback model",
		"/vision-model unset                 clear the override (use the brain model)",
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
		const result = await settingsLoop(flow, {
			title: "Choose the desktop pet state.",
			options: () => PET_OPTIONS,
			renderStatus: () => formatPetStatus(config),
			initial: isPetEnabledValue(config.pet) ? "on" : "off",
			dispatch: async (selected) => {
				if (selected !== "on" && selected !== "off") return undefined;
				return await savePetMode(selected);
			},
		});
		return result ?? "/pet cancelled.";
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
	if (setting === "local-defaults") return await saveLocalVoiceDefaults(config);
	if (setting !== undefined) {
		const value = args.slice(1).join(" ").trim();
		if (value.length > 0) return await saveVoiceSetting(setting, value);
		if (flow === undefined) return voiceSettingUsage(setting);
		return await configureVoiceInteractive(flow, config, setting);
	}

	const provider = parseVoiceRealtimeProvider(args[0]);
	if (provider !== undefined && args.length === 1) return await saveVoiceSetting("mode", provider);
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
	flow.begin("Configure Discord voice");
	try {
		if (initialSetting !== undefined) {
			return (await applyVoiceLeaf(flow, initialSetting, config)) ?? "/voice cancelled.";
		}
		const result = await settingsLoop(flow, {
			title: "Choose the voice setting to change.",
			options: () => VOICE_GROUP_OPTIONS,
			renderStatus: () => formatVoiceMenuStatus(config),
			dispatch: async (choice) => {
				if (choice === "mode") return await applyVoiceLeaf(flow, "mode", config);
				const group = VOICE_GROUPS[choice];
				if (group === undefined) return undefined;
				return await settingsLoop(flow, {
					title: group.title,
					options: () => group.options,
					renderStatus: () => formatVoiceMenuStatus(config),
					initial: group.options[0]?.value,
					dispatch: async (setting) => {
						const parsed = parseVoiceSetting(setting);
						if (parsed === undefined || parsed === "status") return undefined;
						return await applyVoiceLeaf(flow, parsed, config);
					},
				});
			},
		});
		return result ?? "/voice cancelled.";
	} finally {
		flow.end({ preserveDiagnostics: false });
	}
}

// Prompts for one voice leaf setting's value and applies it. Returns the apply
// message, or undefined when the user backs out of the value prompt.
async function applyVoiceLeaf(flow: SetupFlow, setting: VoiceSetting, config: ClankyConfig): Promise<string | undefined> {
	if (setting === "local-defaults") {
		const update = localVoiceDefaultsUpdate(config);
		await writeEnv(update.updates);
		return await restartBrainMessage(update.message);
	}
	const value = await promptVoiceSettingValue(flow, setting, config);
	if (value === undefined) return undefined;
	const result = buildVoiceSettingUpdate(setting, value);
	if (typeof result === "string") return result;
	await writeEnv(result.updates);
	return await restartBrainMessage(result.message);
}

async function promptVoiceSettingValue(
	flow: SetupFlow,
	setting: VoiceSetting,
	config: ClankyConfig,
): Promise<string | undefined> {
	switch (setting) {
		case "local-defaults":
			return "1";
		case "mode":
		case "realtime-provider":
			return await selectOne(
				flow,
				"Choose whether voice uses a hosted realtime provider or the local stack.",
				VOICE_REALTIME_PROVIDER_OPTIONS,
				parseVoiceRealtimeProvider(config.voiceRealtimeProvider) ?? "openai",
				true,
			);
		case "tts-provider":
			return await selectOne(
				flow,
				"Choose the TTS provider.",
				VOICE_TTS_PROVIDER_OPTIONS,
				inferredVoiceTtsProvider(config),
				true,
			);
		case "eve-session": {
			const enabled = parseVoiceToggle(config.voiceEveSession) ?? true;
			return await selectOne(flow, "Enable the Eve continuity session for voice turns.", VOICE_EVE_SESSION_OPTIONS, enabled ? "on" : "off", true);
		}
		case "memory-limit":
			return await flow.readText({
				message: "Set the voice memory context limit.",
				defaultValue: config.voiceMemoryContextLimit ?? "16",
				placeholder: "0-50",
				allowBack: true,
				validate: (value) => (parseVoiceMemoryLimit(value) === undefined ? "Enter a number from 0 to 50." : undefined),
			});
		case "realtime-model":
			return await flow.readText({
				message: "Set the realtime model.",
				defaultValue: config.voiceRealtimeModel ?? "",
				placeholder: defaultRealtimeModel(config),
				allowBack: true,
				validate: requiredVoiceText,
			});
		case "realtime-voice":
			return await flow.readText({
				message: "Set the realtime voice.",
				defaultValue: config.voiceRealtimeVoice ?? "marin",
				placeholder: "marin",
				allowBack: true,
				validate: requiredVoiceText,
			});
		case "elevenlabs-voice":
			return await flow.readText({
				message: "Set the ElevenLabs voice id.",
				defaultValue: config.elevenLabsVoiceId ?? "",
				placeholder: "voice id",
				allowBack: true,
				validate: requiredVoiceText,
			});
		case "elevenlabs-model":
			return await flow.readText({
				message: "Set the ElevenLabs TTS model.",
				defaultValue: config.elevenLabsTtsModel ?? "",
				placeholder: "eleven_flash_v2_5",
				allowBack: true,
				validate: requiredVoiceText,
			});
		case "asr-model":
			return await flow.readText({
				message: "Set the local ASR model path.",
				defaultValue: config.voiceAsrModel ?? defaultVoiceAsrModelPath(),
				placeholder: defaultVoiceAsrModelPath(),
				allowBack: true,
				validate: requiredVoiceText,
			});
		case "asr-command":
			return await flow.readText({
				message: "Set the local ASR command.",
				defaultValue: config.voiceAsrCommand ?? "whisper-cli",
				placeholder: "whisper-cli",
				allowBack: true,
				validate: requiredVoiceText,
			});
		case "local-base-url":
			return await flow.readText({
				message: "Set the local voice LLM endpoint.",
				defaultValue: config.voiceLocalBaseUrl ?? config.localBaseUrl ?? DEFAULT_LOCAL_BASE_URL,
				placeholder: DEFAULT_LOCAL_BASE_URL,
				allowBack: true,
				validate: requiredVoiceText,
			});
		case "local-tts-engine":
			return await selectOne(
				flow,
				"Choose the local TTS engine.",
				VOICE_LOCAL_TTS_ENGINE_OPTIONS,
				parseLocalTtsEngine(config.voiceLocalTtsEngine) ?? "say",
				true,
			);
		case "local-tts-command":
			return await flow.readText({
				message: "Set the local TTS command.",
				defaultValue: config.voiceLocalTtsCommand ?? "",
				placeholder: "command that reads text on stdin and emits s16le PCM",
				allowBack: true,
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

async function saveLocalVoiceDefaults(config: ClankyConfig): Promise<string> {
	const update = localVoiceDefaultsUpdate(config);
	await writeEnv(update.updates);
	return await restartBrainMessage(update.message);
}

function localVoiceDefaultsUpdate(config: Partial<ClankyConfig>): VoiceSettingUpdate {
	const currentProvider = parseVoiceRealtimeProvider(config.voiceRealtimeProvider);
	const model = currentProvider === "local" ? (config.voiceRealtimeModel ?? DEFAULT_LOCAL_VOICE_LLM_MODEL) : DEFAULT_LOCAL_VOICE_LLM_MODEL;
	return {
		updates: {
			CLANKY_DISCORD_VOICE: "1",
			CLANKY_VOICE_REALTIME_PROVIDER: "local",
			CLANKY_VOICE_REALTIME_MODEL: model,
			CLANKY_VOICE_REALTIME_VOICE: config.voiceRealtimeVoice ?? DEFAULT_LOCAL_VOICE,
			CLANKY_VOICE_TTS_PROVIDER: "realtime",
			CLANKY_VOICE_ASR_MODEL: config.voiceAsrModel ?? defaultVoiceAsrModelPath(),
			CLANKY_VOICE_ASR_COMMAND: config.voiceAsrCommand ?? "whisper-cli",
			CLANKY_VOICE_LOCAL_BASE_URL: config.voiceLocalBaseUrl ?? config.localBaseUrl ?? DEFAULT_LOCAL_BASE_URL,
			CLANKY_VOICE_LOCAL_TTS_ENGINE: config.voiceLocalTtsEngine ?? "say",
			CLANKY_VOICE_MEMORY_CONTEXT_LIMIT: config.voiceMemoryContextLimit ?? "16",
			CLANKY_VOICE_EVE_SESSION: config.voiceEveSession ?? "1",
		},
		message: "Voice mode set to local: Whisper ASR, local LLM, and local realtime TTS",
	};
}

function buildVoiceSettingUpdate(setting: VoiceSetting, rawValue: string): VoiceSettingUpdate | string {
	const value = rawValue.trim();
	if (value.length === 0) return voiceSettingUsage(setting);
	switch (setting) {
		case "local-defaults":
			return localVoiceDefaultsUpdate({});
		case "mode":
		case "realtime-provider": {
			const provider = parseVoiceRealtimeProvider(value);
			if (provider === undefined) return `Unknown voice realtime provider "${value}". Use openai, xai, or local.`;
			if (provider === "local") return localVoiceDefaultsUpdate({});
			const model = defaultRealtimeModelForProvider(provider);
			const voice = defaultRealtimeVoiceForProvider(provider);
			return {
				updates: {
					CLANKY_VOICE_REALTIME_PROVIDER: provider,
					CLANKY_VOICE_REALTIME_MODEL: model,
					CLANKY_VOICE_REALTIME_VOICE: voice,
					CLANKY_VOICE_TTS_PROVIDER: "realtime",
				},
				message: `Voice mode set to provider (${provider}) using ${model}`,
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
		case "asr-model":
			return {
				updates: { CLANKY_VOICE_ASR_MODEL: value },
				message: `Voice ASR model set to ${value}`,
			};
		case "asr-command":
			return {
				updates: { CLANKY_VOICE_ASR_COMMAND: value },
				message: `Voice ASR command set to ${value}`,
			};
		case "local-base-url":
			return {
				updates: { CLANKY_VOICE_LOCAL_BASE_URL: value },
				message: `Voice local LLM endpoint set to ${value}`,
			};
		case "local-tts-engine": {
			const engine = parseLocalTtsEngine(value);
			if (engine === undefined) return `Unknown local voice TTS engine "${value}". Use say or command.`;
			return {
				updates: { CLANKY_VOICE_LOCAL_TTS_ENGINE: engine },
				message: `Voice local TTS engine set to ${engine}`,
			};
		}
		case "local-tts-command":
			return {
				updates: { CLANKY_VOICE_LOCAL_TTS_COMMAND: value },
				message: "Voice local TTS command set",
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
	const first = args[0]?.toLowerCase();
	if (first === "status" || first === "show") return formatIntegrationTable(current, available);
	const role = parseIntegrationRole(args[0]);
	if (args[0] !== undefined && role === undefined) {
		return `Unknown integration role "${args[0]}". Use status or one of: ${INTEGRATION_ROLES.map((entry) => entry.label).join(", ")}.`;
	}
	if (role !== undefined && args[1] !== undefined) {
		const binding = parseIntegrationBinding(args[1], available);
		if (binding === "invalid") return `Unknown connection "${args[1]}". Available connections: ${formatAvailableConnections(available)}.`;
		await setRoleBinding(role, binding);
		return integrationSavedMessage(role, binding);
	}
	if (flow === undefined) {
		return `${formatIntegrationTable(current, available)}\n\nUsage: /integrations [status|role] [connection|unset]`;
	}

	flow.begin("Configure integration roles");
	try {
		flow.renderOutput(formatIntegrationTable(current, available));
		const result = await settingsLoop(flow, {
			title: "Choose the integration role to bind.",
			options: () => [
				{ value: "status", label: "status", hint: "show current bindings" },
				...INTEGRATION_ROLES.map((entry) => ({
					value: entry.key,
					label: entry.label,
					hint: current[entry.key] ?? "unset",
				})),
			],
			initial: role ?? "status",
			dispatch: async (selectedRoleValue) => {
				if (selectedRoleValue === "status") return formatIntegrationTable(current, available);
				const selectedRole = parseIntegrationRole(selectedRoleValue);
				if (selectedRole === undefined) return undefined;
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
					true,
				);
				if (selectedBinding === undefined) return undefined;
				const binding = selectedBinding === "unset" ? undefined : selectedBinding;
				await setRoleBinding(selectedRole, binding);
				return integrationSavedMessage(selectedRole, binding);
			},
		});
		return result ?? "/integrations cancelled.";
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
		return (await configureMcpInteractive(flow, renderer)) ?? "/mcp cancelled.";
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
				return (await promptAndRemoveMcpServer(flow)) ?? "/mcp remove cancelled.";
			} finally {
				flow.end({ preserveDiagnostics: false });
			}
		case "enable":
		case "disable":
			if (args[1] !== undefined) return await setDynamicMcpServerEnabled(args[1], action === "enable");
			if (flow === undefined) return `Usage: /mcp ${action} <name>`;
			flow.begin(`${action === "enable" ? "Enable" : "Disable"} dynamic MCP server`);
			try {
				return (await promptAndSetMcpServerEnabled(flow, action === "enable")) ?? `/mcp ${action} cancelled.`;
			} finally {
				flow.end({ preserveDiagnostics: false });
			}
		case "auth":
			if (flow === undefined) return "Usage: /mcp auth <connection>";
			if (args[1] === undefined) return (await configureMcpInteractive(flow, renderer, "auth")) ?? "/mcp auth cancelled.";
			return await runMcpAuthCommand(args[1], flow, renderer);
		case "install":
			if (flow === undefined) return "Usage: /mcp install <linear|figma|connection>";
			if (args[1] === undefined) return (await configureMcpInteractive(flow, renderer, "install")) ?? "/mcp install cancelled.";
			return await runMcpInstallCommand(args[1], flow, renderer);
	}
}

const MCP_ADD_DYNAMIC_VALUE = "__mcp_add_dynamic__";
const MCP_CONNECTION_VALUE_PREFIX = "conn:";
const MCP_DYNAMIC_VALUE_PREFIX = "dyn:";

// The /mcp modal is an inventory browser: every curated connection and dynamic
// server is a selectable row showing live status. Selecting a curated
// connection authorizes/verifies it (and surfaces discovered tools); selecting
// a dynamic server drills into a per-server submenu (view tools / toggle /
// remove). `initialAction` ("auth"/"install") preserves the direct
// /mcp auth and /auth mcp entry points by jumping straight to the picker.
async function configureMcpInteractive(
	flow: SetupFlow,
	renderer: CommandRenderer,
	initialAction?: McpCommandAction,
	options: MenuBackOptions = {},
): Promise<string | undefined> {
	flow.begin("Manage MCPs");
	try {
		if (initialAction === "auth" || initialAction === "install") {
			const connection = await selectMcpConnectionName(flow, initialAction === "install" ? "linear" : undefined, true);
			if (connection === undefined) return options.backReturnsToMenu === true ? undefined : `/mcp ${initialAction} cancelled.`;
			return await runMcpConnectionAuthByName(connection, flow, renderer);
		}

		let inventory = await mcpInventoryOptions();
		let status = await mcpModalStatus();
		const refresh = async (): Promise<void> => {
			inventory = await mcpInventoryOptions();
			status = await mcpModalStatus();
		};

		const result = await settingsLoop(flow, {
			title: "Select an MCP to connect, view, or manage.",
			options: () => inventory,
			renderStatus: () => status,
			dispatch: async (value): Promise<string | undefined> => {
				if (value === MCP_ADD_DYNAMIC_VALUE) {
					flow.renderOutput(await promptAndSaveMcpServer(flow));
					await refresh();
					return undefined;
				}
				if (value.startsWith(MCP_CONNECTION_VALUE_PREFIX)) {
					flow.renderOutput(await runMcpConnectionAuthByName(value.slice(MCP_CONNECTION_VALUE_PREFIX.length), flow, renderer));
					await refresh();
					return undefined;
				}
				if (value.startsWith(MCP_DYNAMIC_VALUE_PREFIX)) {
					await mcpDynamicServerMenu(value.slice(MCP_DYNAMIC_VALUE_PREFIX.length), flow);
					await refresh();
					return undefined;
				}
				return undefined;
			},
		});
		return result ?? (options.backReturnsToMenu === true ? undefined : "/mcp cancelled.");
	} finally {
		flow.end({ preserveDiagnostics: false });
	}
}

// Build the inventory rows for the /mcp modal: curated connections first (with
// live auth status), then dynamic servers (enabled/disabled + source), then the
// add-dynamic action.
async function mcpInventoryOptions(): Promise<MenuOption[]> {
	const [info, store, states] = await Promise.all([fetchInfo(), listMcpServerConfigs(), readMcpOAuthStates()]);
	const rows: MenuOption[] = [];
	for (const connection of mcpConnections(info)) {
		const live = mcpConnectionLiveStatus(connection, states);
		rows.push({
			value: `${MCP_CONNECTION_VALUE_PREFIX}${connection.connectionName}`,
			label: connection.connectionName,
			hint: `curated · ${live.label}`,
			description: connection.description,
		});
	}
	for (const name of Object.keys(store.servers).sort((a, b) => a.localeCompare(b))) {
		const config = store.servers[name];
		const state = config?.disabled === true ? "disabled" : "enabled";
		rows.push({
			value: `${MCP_DYNAMIC_VALUE_PREFIX}${name}`,
			label: name,
			hint: `dynamic · ${state} · ${dynamicMcpSourceHint(name, store)}`,
			description: formatMcpConfigTarget(config),
		});
	}
	rows.push({ value: MCP_ADD_DYNAMIC_VALUE, label: "add dynamic MCP", hint: "stdio/http/sse no-auth or static-token MCP" });
	return rows;
}

async function mcpModalStatus(): Promise<SettingsMenuStatus> {
	const [info, store, states] = await Promise.all([fetchInfo(), listMcpServerConfigs(), readMcpOAuthStates()]);
	const collapsed = [statusTitle("MCPs"), formatMcpModalSummary(info, store, states)].join("\n");
	const expanded = [
		statusTitle("MCPs"),
		statusSection("Curated connections"),
		...formatMcpConnectionLines(info, states),
		"",
		statusSection("Dynamic servers"),
		...formatDynamicMcpLines(store),
	].join("\n");
	return collapsibleMenuStatus(collapsed, expanded);
}

function formatMcpModalSummary(
	info: AgentInfoResult | undefined,
	store: Awaited<ReturnType<typeof listMcpServerConfigs>>,
	states: Record<string, McpOAuthState>,
): string {
	const connections = mcpConnections(info);
	const authed = connections.filter((c) => mcpConnectionHasAuthorization(c) && (states[c.connectionName] ?? "unauthorized") !== "unauthorized");
	const needAuth = connections.filter((c) => mcpConnectionHasAuthorization(c) && (states[c.connectionName] ?? "unauthorized") === "unauthorized");
	const dynamicNames = Object.keys(store.servers);
	const disabled = dynamicNames.filter((name) => store.servers[name]?.disabled === true).length;
	const curated =
		info === undefined
			? statusValue("unavailable", "warn")
			: connections.length === 0
				? statusValue("none", "muted")
				: `${statusValue(`${authed.length} authorized`, authed.length > 0 ? "ok" : "muted")}${needAuth.length > 0 ? `, ${statusValue(`${needAuth.length} need auth`, "warn")}` : ""}`;
	const dynamic =
		dynamicNames.length === 0
			? statusValue("none", "muted")
			: `${dynamicNames.length}${disabled > 0 ? ` (${disabled} disabled)` : ""}`;
	return [statusLine("curated", curated), statusLine("dynamic", dynamic)].join("\n");
}

// Per-server submenu for a dynamic MCP: view its live tool list, toggle it, or
// remove it. File-backed servers can be toggled/removed; env-injected servers
// are read-only here.
async function mcpDynamicServerMenu(name: string, flow: SetupFlow): Promise<string | undefined> {
	let store = await listMcpServerConfigs();
	return await settingsLoop(flow, {
		title: `Manage ${name}.`,
		renderStatus: () => dynamicMcpServerStatusLine(name, store),
		options: () => dynamicMcpServerOptions(name, store),
		dispatch: async (value): Promise<string | undefined> => {
			if (value === "tools") {
				flow.renderOutput(await mcpToolListText(name));
				return undefined;
			}
			if (value === "enable" || value === "disable") {
				flow.renderOutput(await setDynamicMcpServerEnabled(name, value === "enable"));
				store = await listMcpServerConfigs();
				return undefined;
			}
			if (value === "remove") {
				const result = await removeDynamicMcpServer(name);
				flow.renderOutput(result);
				return result;
			}
			return undefined;
		},
	});
}

function dynamicMcpServerStatusLine(name: string, store: Awaited<ReturnType<typeof listMcpServerConfigs>>): string {
	const config = store.servers[name];
	const lines = [statusTitle(name)];
	if (config === undefined) {
		lines.push(statusLine("config", "(unavailable)", "warn"));
		return lines.join("\n");
	}
	const enabled = config.disabled !== true;
	lines.push(
		statusLine("state", enabled ? "enabled" : "disabled", enabled ? "ok" : "muted"),
		statusLine("source", dynamicMcpSourceHint(name, store)),
		statusLine("target", formatMcpConfigTarget(config)),
	);
	if (config.description !== undefined) lines.push(statusLine("description", config.description));
	return lines.join("\n");
}

function dynamicMcpServerOptions(name: string, store: Awaited<ReturnType<typeof listMcpServerConfigs>>): MenuOption[] {
	const fileBacked = store.fileServers[name] !== undefined;
	const enabled = store.servers[name]?.disabled !== true;
	const rows: MenuOption[] = [{ value: "tools", label: "view tools", hint: "connect and list this server's tools" }];
	if (fileBacked) {
		rows.push(
			enabled
				? { value: "disable", label: "disable", hint: "stop loading this server" }
				: { value: "enable", label: "enable", hint: "load this server again" },
			{ value: "remove", label: "remove", hint: "delete from the file-backed store" },
		);
	}
	return rows;
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

async function promptAndRemoveMcpServer(
	flow: SetupFlow,
	options: MenuBackOptions = {},
): Promise<string | undefined> {
	const name = await selectDynamicMcpServer(flow, "Choose the file-backed dynamic MCP server to remove.", false, options.backReturnsToMenu === true);
	if (name === undefined) return options.backReturnsToMenu === true ? undefined : "/mcp remove cancelled.";
	const confirmed = await selectOne(
		flow,
		`Remove dynamic MCP server "${name}" from the file-backed store?`,
		[
			{ value: "cancel", label: "cancel" },
			{ value: "remove", label: "remove", hint: "delete from ~/.clanky/mcp-servers.json" },
		],
		"cancel",
		options.backReturnsToMenu === true,
	);
	if (confirmed === undefined) return options.backReturnsToMenu === true ? undefined : "/mcp remove cancelled.";
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

async function promptAndSetMcpServerEnabled(
	flow: SetupFlow,
	enabled: boolean,
	options: MenuBackOptions = {},
): Promise<string | undefined> {
	const name = await selectDynamicMcpServer(
		flow,
		`Choose the file-backed dynamic MCP server to ${enabled ? "enable" : "disable"}.`,
		false,
		options.backReturnsToMenu === true,
	);
	if (name === undefined) return options.backReturnsToMenu === true ? undefined : `/mcp ${enabled ? "enable" : "disable"} cancelled.`;
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
	allowBack = false,
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
		allowBack,
	);
}

async function selectMcpConnectionName(
	flow: SetupFlow,
	initialValue: string | undefined,
	allowBack = false,
): Promise<string | undefined> {
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
		allowBack,
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
	const [info, store, states] = await Promise.all([fetchInfo(), listMcpServerConfigs(), readMcpOAuthStates()]);
	return [
		"Curated MCP connections (eve connections; OAuth/brokered auth):",
		...formatMcpConnectionLines(info, states),
		"",
		`Dynamic MCP servers (${store.path} + CLANKY_MCP_SERVERS):`,
		...formatDynamicMcpLines(store),
		"",
		"Use /mcp auth linear or /mcp auth figma for OAuth. Use /mcp add only for no-auth/static-token dynamic MCPs.",
	].join("\n");
}

async function mcpConnectionsText(): Promise<string> {
	const [info, states] = await Promise.all([fetchInfo(), readMcpOAuthStates()]);
	return ["Curated MCP connections (installed under agent/connections):", ...formatMcpConnectionLines(info, states)].join("\n");
}

async function mcpToolListText(server: string | undefined): Promise<string> {
	const statuses = await listMcpTools({ server, timeoutMs: 10_000 });
	if (statuses.length === 0) return "No dynamic MCP servers are configured.";
	return statuses.map(formatMcpServerStatus).join("\n\n");
}

function formatMcpConnectionLines(info: AgentInfoResult | undefined, states: Record<string, McpOAuthState>): string[] {
	if (info === undefined) return [MCP_CONNECTION_INFO_UNAVAILABLE];
	const connections = mcpConnections(info);
	if (connections.length === 0) return ["(none)"];
	return connections.map((connection) => {
		const live = mcpConnectionLiveStatus(connection, states);
		const approval = mcpConnectionHasApproval(connection) ? "approval" : "no approval";
		return `- ${ansi.bold(connection.connectionName)}: ${statusValue(live.label, live.tone)} ${ansi.dim(`(${connection.protocol}, ${approval})`)} - ${ansi.dim(connection.description)}`;
	});
}

function mcpConnectionAuthHint(connection: AgentInfoConnectionEntry): string {
	return mcpConnectionHasAuthorization(connection) ? "oauth" : "no oauth";
}

// Live, locally-derived auth status for a curated connection: reads the
// persisted OAuth token store (no network), so /mcp and /auth can show whether
// each connection is actually authorized rather than just whether it requires
// auth.
function mcpConnectionLiveStatus(
	connection: AgentInfoConnectionEntry,
	states: Record<string, McpOAuthState>,
): { label: string; tone: StatusTone } {
	if (!mcpConnectionHasAuthorization(connection)) return { label: "no auth needed", tone: "muted" };
	switch (states[connection.connectionName] ?? "unauthorized") {
		case "authorized":
			return { label: "authorized", tone: "ok" };
		case "expired":
			return { label: "authorized (token expired, refreshes on use)", tone: "ok" };
		default:
			return { label: "not authorized", tone: "warn" };
	}
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

// `/pair` — the face-side mirror of `clanky pair` (SPEC §4.4). Renders the
// `clanky://connect` QR inline so the iOS app can pair without dropping to a
// shell. `/pair link` prints just the deep link for narrow panes or AirDrop.
async function configurePairing(argument: string): Promise<string> {
	const linkOnly = argument.trim().toLowerCase() === "link";
	const fileEnv = parseEnv(await readFile(ENV_PATH, "utf8").catch(() => ""));
	const token = process.env.CLANKY_RELAY_TOKEN ?? fileEnv.CLANKY_RELAY_TOKEN ?? "";
	let link: PairingLink;
	try {
		link = await buildPairingLink({
			token,
			port: PORT,
			configuredHost: process.env.CLANKY_EVE_HOST ?? fileEnv.CLANKY_EVE_HOST,
		});
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
	if (linkOnly) {
		return `Open this link on the phone to pair Clanky iOS (relay ${link.relayUrl}):\n${link.url}`;
	}
	const qr = await renderPairingQr(link.url);
	insertTranscript(new Text(qr, 1, 1));
	tui.requestRender();
	return [
		`Scan the QR above with the Clanky iOS app to pair (relay ${link.relayUrl}).`,
		`Or open this link on the phone:`,
		link.url,
		`Run /pair link to print just the link if the QR will not scan.`,
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
		statusTitle("Clanky status"),
		statusLine("model", model, model === "(model unknown)" ? "warn" : "active"),
		statusLine("eve brain", formatBrainHealthSummary(brainHealth), brainHealth.state === "healthy" ? "ok" : brainHealth.state === "unknown" ? "muted" : "warn"),
		statusLine("running conductor", formatRunningConductorSummary(config), startupModelFallback !== undefined && config.provider === startupModelFallback.provider ? "warn" : "active"),
		statusLine("auth", `claude=${formatCredStatus(claudeAuth)}; codex=${formatCredStatus(codexAuth)}`, claudeAuth.present || codexAuth.present ? "ok" : "warn"),
		statusLine("approvals", isAutoApproveValue(config.autoApprove) ? "auto (no prompts)" : "prompt", isAutoApproveValue(config.autoApprove) ? "warn" : "ok"),
		statusLine("agent files", formatAgentMdSummary(config), agentMdEnabled(config) ? "active" : "muted"),
		statusLine("coding harness", formatCodingHarnessSummary(config), "active"),
		statusLine("image model", `${currentImageProvider(config)}=${imageModelFor(config, currentImageProvider(config))}`, "active"),
		statusLine("video model", `${config.videoProvider?.trim() || "xai"}=${currentVideoModel(config)}`, "active"),
		statusLine("vision model", `${isTruthyEnvValue(config.visionEnabled) ? `override=${config.visionModel ?? "(none)"}` : "brain model"}; openai fallback=${config.openAiVisionModel ?? "gpt-5.4-mini"}`, isTruthyEnvValue(config.visionEnabled) ? "active" : "ok"),
		...formatVoiceStatusLines(config),
		statusLine("integrations", formatIntegrationSummary(bindings, connections)),
		statusLine("mcp", formatMcpStatusSummary(info, mcpStore)),
		statusLine("browser bridge", formatBrowserBridgeSummary(browser)),
		statusLine("discord scope", formatDiscordScopeSummary(config)),
		statusLine("discord gateway", formatJson(gateway), "muted"),
	];
	return lines.join("\n");
}

async function skillsOutcome(): Promise<PromptCommandOutcome> {
	let entries: ClankySkillInventoryEntry[];
	try {
		const config = await readConfig();
		entries = await listClankySkills(REPO, { includeInherited: agentMdEnabled(config) });
	} catch (error) {
		return { message: `Could not read Clanky skills: ${error instanceof Error ? error.message : String(error)}` };
	}
	if (entries.length === 0) return { message: "No Clanky skills found." };
	return {
		component: new ClankySkillsPanelComponent(entries),
		ledgerMessage: `Showed ${entries.length} Clanky ${pluralWord(entries.length, "skill")}.`,
	};
}

class ClankySkillsPanelComponent implements Component {
	private readonly entries: readonly ClankySkillInventoryEntry[];

	constructor(entries: readonly ClankySkillInventoryEntry[]) {
		this.entries = entries;
	}

	invalidate(): void {}

	render(width: number): string[] {
		return renderClankySkillsPanel(this.entries, width, {
			bold: ansi.bold,
			cyan: ansi.cyan,
			dim: ansi.dim,
			yellow: ansi.yellow,
		});
	}
}

async function configureAgents(argument: string, flow: SetupFlow | undefined): Promise<string> {
	// Headless/relay callers have no overlay surface; keep the printed roster.
	if (flow === undefined) return await listClankyAgentsText(argument);
	return await configureAgentsInteractive(flow, splitArgs(argument)[0]?.toLowerCase() === "all");
}

async function configureAgentsInteractive(flow: SetupFlow, startExpanded: boolean): Promise<string> {
	let agents: HerdrAgentInfo[];
	try {
		agents = await listHerdrAgents();
	} catch (error) {
		return `Could not read the herdr stage: ${error instanceof Error ? error.message : String(error)}`;
	}
	// herdr can report the same pane under multiple agent sources; keep one row each.
	const deduped = [...new Map(agents.map((agent) => [agent.paneId, agent])).values()];
	// Include the conductor (clanky:main) so Clanky sees himself on the stage; it
	// sorts first via sortAgentsForRoster and is labelled as the conductor.
	const clankyAgents = sortAgentsForRoster(deduped.filter((agent) => agent.agent.startsWith("clanky:")));
	const others = sortAgentsForRoster(deduped.filter((agent) => !agent.agent.startsWith("clanky:")));
	if (clankyAgents.length === 0 && others.length === 0) {
		return `No herdr agents on the stage. Start a worker with ${ansi.cyan("/spawn")}.`;
	}
	let showOthers = startExpanded;
	flow.begin("Herdr agents");
	try {
		const result = await settingsLoop(flow, {
			title: "Choose the herdr agent to message.",
			renderStatus: () => formatAgentsMenuStatus(clankyAgents, others, showOthers),
			options: () => buildAgentMenuOptions(clankyAgents, others, showOthers),
			dispatch: async (value) => {
				if (value === AGENTS_TOGGLE_VALUE) {
					showOthers = !showOthers;
					return undefined;
				}
				const agent = [...clankyAgents, ...others].find((candidate) => candidate.paneId === value);
				if (agent === undefined) return undefined;
				const slug = agentTagSlug(agent);
				insertAgentTag(slug);
				return `Tagged @${slug}; type your instruction and send to direct it at that agent.`;
			},
		});
		return result ?? "/agents closed.";
	} finally {
		flow.end({ preserveDiagnostics: false });
	}
}

function buildAgentMenuOptions(
	clankyAgents: readonly HerdrAgentInfo[],
	others: readonly HerdrAgentInfo[],
	showOthers: boolean,
): MenuOption[] {
	const options: MenuOption[] = clankyAgents.map(agentMenuOption);
	if (others.length > 0) {
		options.push({
			value: AGENTS_TOGGLE_VALUE,
			label: showOthers ? "hide other herdr agents" : `show ${others.length} other herdr ${pluralWord(others.length, "agent")}`,
			hint: showOthers ? "collapse the full stage" : "expand the full stage",
		});
		if (showOthers) options.push(...others.map(agentMenuOption));
	}
	return options;
}

function agentMenuOption(agent: HerdrAgentInfo): MenuOption {
	const cwd = agent.foregroundCwd.trim() || agent.cwd.trim();
	const status = agent.agent === "clanky:main" ? "conductor (this session)" : normalizeAgentStatus(agent.agentStatus);
	return {
		value: agent.paneId,
		label: `@${agentTagSlug(agent)}`,
		hint: cwd.length === 0 ? status : `${status} · ${displayHomePath(cwd)}`,
	};
}

function agentTagSlug(agent: HerdrAgentInfo): string {
	return agent.agent.startsWith("clanky:") ? agent.agent.slice("clanky:".length) : agent.agent;
}

function formatAgentsMenuStatus(clankyAgents: readonly HerdrAgentInfo[], others: readonly HerdrAgentInfo[], showOthers: boolean): string {
	const parts = [`Clanky agents: ${clankyAgents.length}`];
	if (others.length > 0) parts.push(`other herdr agents: ${others.length} (${showOthers ? "shown" : "hidden"})`);
	return parts.join(" · ");
}

function insertAgentTag(slug: string): void {
	const existing = editor.getText();
	const tag = `@${slug} `;
	const next = existing.trim().length === 0 ? tag : `${tag}${existing}`;
	editor.setText(next);
	tui.setFocus(editor);
	refreshCommandSurface(next);
	tui.requestRender();
}

async function listClankyAgentsText(argument: string): Promise<string> {
	const showAll = splitArgs(argument)[0]?.toLowerCase() === "all";
	let agents: HerdrAgentInfo[];
	try {
		agents = await listHerdrAgents();
	} catch (error) {
		return `Could not read the herdr stage: ${error instanceof Error ? error.message : String(error)}`;
	}
	// herdr can report the same pane under multiple agent sources; keep one row each.
	const deduped = [...new Map(agents.map((agent) => [agent.paneId, agent])).values()];
	const workers = deduped.filter((agent) => agent.agent.startsWith("clanky:"));
	const others = deduped.filter((agent) => !agent.agent.startsWith("clanky:"));
	return formatClankyAgentsPanel(workers, others, showAll);
}

function formatClankyAgentsPanel(
	workers: readonly HerdrAgentInfo[],
	others: readonly HerdrAgentInfo[],
	showAll: boolean,
): string {
	const lines = [
		formatAgentsSectionHeader("Clanky workers", workers, "worker"),
		formatAgentStatusCounts(workers),
	];
	if (workers.length === 0) {
		lines.push("", ansi.dim("No Clanky workers on the stage."), `Start one with ${ansi.cyan("/spawn")} or ${ansi.cyan("/spawn <slug> <task>")}.`);
	} else {
		lines.push("", ...formatAgentRosterRows(sortAgentsForRoster(workers)));
	}
	if (showAll && others.length > 0) {
		lines.push("", formatAgentsSectionHeader("Other herdr agents", others, "agent"), formatAgentStatusCounts(others), "");
		lines.push(...formatAgentRosterRows(sortAgentsForRoster(others)));
	} else if (showAll) {
		lines.push("", `${ansi.bold("Other herdr agents")} ${ansi.dim("none on the stage")}`);
	} else if (others.length > 0) {
		lines.push(
			"",
			`${ansi.dim(`${others.length} other herdr ${pluralWord(others.length, "agent")} hidden.`)} ${ansi.cyan("/agents all")} ${ansi.dim("shows the full stage.")}`,
		);
	}
	return renderClankyOutline(lines, AGENTS_PANEL_WIDTH, ansi.dim).join("\n");
}

function formatAgentsSectionHeader(label: string, agents: readonly HerdrAgentInfo[], noun: string): string {
	return `${ansi.bold(label)} ${ansi.dim(`${agents.length} ${pluralWord(agents.length, noun)}`)}`;
}

function formatAgentStatusCounts(agents: readonly HerdrAgentInfo[]): string {
	if (agents.length === 0) return ansi.dim("no matching panes");
	const counts = new Map<string, number>();
	for (const agent of agents) {
		const status = normalizeAgentStatus(agent.agentStatus);
		counts.set(status, (counts.get(status) ?? 0) + 1);
	}
	const ordered = ["working", "blocked", "idle", "done", "unknown"];
	const parts = ordered
		.filter((status) => (counts.get(status) ?? 0) > 0)
		.map((status) => colorAgentStatusCount(status, counts.get(status) ?? 0));
	for (const [status, count] of [...counts.entries()].sort(([left], [right]) => left.localeCompare(right))) {
		if (!ordered.includes(status)) parts.push(colorAgentStatusCount(status, count));
	}
	return parts.join(ansi.dim("  "));
}

function formatAgentRosterRows(agents: readonly HerdrAgentInfo[]): string[] {
	const lines: string[] = [];
	for (const agent of agents) {
		lines.push(formatAgentRosterPrimary(agent));
		const cwd = formatAgentRosterCwd(agent);
		if (cwd !== undefined) lines.push(cwd);
	}
	return lines;
}

function formatAgentRosterPrimary(agent: HerdrAgentInfo): string {
	const status = padVisible(agentStatusBadge(agent.agentStatus), 12);
	const name = padVisible(truncateToWidth(formatAgentName(agent), 33, "", true), 33);
	const meta = agent.focused ? `pane ${agent.paneId} ${ansi.cyan("focused")}` : `pane ${agent.paneId}`;
	return `${status} ${name} ${ansi.dim(meta)}`;
}

function formatAgentName(agent: HerdrAgentInfo): string {
	const role = agent.agent === "clanky:main" ? "conductor" : agent.agent.startsWith("clanky:") ? "worker" : undefined;
	return role === undefined ? ansi.bold(agent.agent) : `${ansi.bold(agent.agent)} ${ansi.dim(role)}`;
}

function formatAgentRosterCwd(agent: HerdrAgentInfo): string | undefined {
	const cwd = (agent.foregroundCwd.trim() || agent.cwd.trim());
	if (cwd.length === 0) return undefined;
	return `${ansi.dim("  cwd")} ${ansi.code(truncateToWidth(displayHomePath(cwd), 62, "", true))}`;
}

function sortAgentsForRoster(agents: readonly HerdrAgentInfo[]): HerdrAgentInfo[] {
	return [...agents].sort((left, right) => {
		const rank = agentRosterRank(left) - agentRosterRank(right);
		if (rank !== 0) return rank;
		if (left.focused !== right.focused) return left.focused ? -1 : 1;
		return left.agent.localeCompare(right.agent);
	});
}

function agentRosterRank(agent: HerdrAgentInfo): number {
	if (agent.agent === "clanky:main") return 0;
	switch (normalizeAgentStatus(agent.agentStatus)) {
		case "working":
			return 1;
		case "blocked":
			return 2;
		case "idle":
			return 3;
		case "done":
			return 4;
		default:
			return 5;
	}
}

function agentStatusBadge(status: string): string {
	const normalized = normalizeAgentStatus(status);
	switch (normalized) {
		case "working":
			return ansi.yellow("● working");
		case "blocked":
			return ansi.red("● blocked");
		case "idle":
			return ansi.green("○ idle");
		case "done":
			return ansi.green("✓ done");
		case "unknown":
			return ansi.dim("○ unknown");
		default:
			return ansi.cyan(`● ${normalized}`);
	}
}

function colorAgentStatusCount(status: string, count: number): string {
	const text = `${count} ${status}`;
	switch (status) {
		case "working":
			return ansi.yellow(text);
		case "blocked":
			return ansi.red(text);
		case "idle":
		case "done":
			return ansi.green(text);
		case "unknown":
			return ansi.dim(text);
		default:
			return ansi.cyan(text);
	}
}

function normalizeAgentStatus(status: string): string {
	const normalized = status.trim().toLowerCase();
	return normalized.length === 0 ? "unknown" : normalized;
}

function pluralWord(count: number, noun: string): string {
	return count === 1 ? noun : `${noun}s`;
}

function padVisible(text: string, width: number): string {
	return text + " ".repeat(Math.max(0, width - visibleWidth(text)));
}

type FaceSpawnRequest = {
	readonly slug: string;
	readonly task: string;
	readonly harness: CodingHarnessId;
	readonly cwd?: string;
};

async function spawnWorkerFromFace(argument: string, flow: SetupFlow | undefined): Promise<string> {
	const request = argument.trim().length === 0
		? await promptSpawnWorkerFromFace(flow)
		: parseSpawnWorkerArgument(argument);
	if (request === undefined) return "/spawn cancelled.";
	if (typeof request === "string") return request;

	const config = await readConfig();
	// Feed the configured harness allowlist/launch settings to the seam so /spawn
	// resolves the same harness the eve brain would, then pin transcript home/session.
	const env: NodeJS.ProcessEnv = { ...process.env, ...codingHarnessEnv(config) };
	try {
		const result = await spawnClankyWorker({
			slug: request.slug,
			task: request.task,
			harness: request.harness,
			cwd: request.cwd,
			env,
		});
		const pane = result.paneId ?? "(pane unknown)";
		const lines = [
			`Spawned \`${result.agent}\` - ${result.harnessLabel} (${result.performer} · ${result.codingRuntime}) · pane ${pane}.`,
		];
		if (result.transcript.readCommand !== null) lines.push(`Transcript: \`${result.transcript.readCommand}\``);
		lines.push("Watch it with `/agents`.");
		return lines.join("\n");
	} catch (error) {
		return `Spawn failed: ${error instanceof Error ? error.message : String(error)}`;
	}
}

function parseSpawnWorkerArgument(argument: string): FaceSpawnRequest | string {
	let tokens: string[];
	try {
		tokens = splitCommandLine(argument);
	} catch (error) {
		return `Invalid /spawn command: ${error instanceof Error ? error.message : String(error)}`;
	}
	const help = tokens[0]?.toLowerCase();
	if (tokens.length === 1 && (help === "help" || help === "--help" || help === "-h")) return SPAWN_USAGE;

	let harnessArg: string | undefined;
	let cwdArg: string | undefined;
	let index = 0;
	// Leading --flags are options; the first bare token is the slug and the rest is
	// the verbatim task brief (so task words are never mistaken for flags).
	while (index < tokens.length && tokens[index].startsWith("--")) {
		const rawFlag = tokens[index] ?? "";
		const equalIndex = rawFlag.indexOf("=");
		const flag = equalIndex === -1 ? rawFlag : rawFlag.slice(0, equalIndex);
		const inlineValue = equalIndex === -1 ? undefined : rawFlag.slice(equalIndex + 1);
		const value = inlineValue ?? tokens[index + 1];
		if (value === undefined) return `Missing value for ${flag}. ${SPAWN_USAGE}`;
		if (flag === "--harness") harnessArg = value;
		else if (flag === "--cwd") cwdArg = value;
		else return `Unknown flag ${flag}. ${SPAWN_USAGE}`;
		index += inlineValue === undefined ? 2 : 1;
	}
	const slug = tokens[index];
	const task = tokens.slice(index + 1).join(" ").trim();
	if (slug === undefined || task.length === 0) return SPAWN_USAGE;
	const slugError = validateSpawnSlugText(slug);
	if (slugError !== undefined) return slugError;

	if (harnessArg === undefined) return `Choose a harness explicitly. ${SPAWN_USAGE}`;
	const harness = parseCodingHarnessId(harnessArg);
	if (harness === undefined) {
		return `Unknown harness '${harnessArg}'. Allowed: ${CODING_HARNESS_IDS.join(", ")}.`;
	}

	return { slug, task, harness, cwd: normalizedOptionalText(cwdArg) };
}

async function promptSpawnWorkerFromFace(flow: SetupFlow | undefined): Promise<FaceSpawnRequest | string | undefined> {
	const config = await readConfig();
	if (flow === undefined) return `${formatSpawnWorkerConfig(config)}\n\n${SPAWN_USAGE}`;

	let request: FaceSpawnRequest | undefined;
	flow.begin("Spawn Clanky worker");
	try {
		flow.renderOutput(formatSpawnWorkerConfig(config));
		const slug = await flow.readText({
			message: "Name the worker pane.",
			placeholder: "docs-review",
			validate: validateSpawnSlugText,
		});
		if (slug === undefined) return undefined;
		const task = await flow.readText({
			message: "Describe the task for the worker.",
			placeholder: "Review the changed files and report findings.",
			validate: requiredSpawnTaskText,
		});
		if (task === undefined) return undefined;

		const harnessChoice = await selectOne(
			flow,
			"Choose the worker harness.",
			spawnHarnessOptions(config),
			spawnHarnessOptions(config)[0]?.value,
		);
		if (harnessChoice === undefined) return undefined;
		const harness = parseCodingHarnessId(harnessChoice);
		if (harness === undefined) {
			return `Unknown harness '${harnessChoice}'. Allowed: ${CODING_HARNESS_IDS.join(", ")}.`;
		}

		const cwd = await flow.readText({
			message: "Set the host working directory.",
			defaultValue: process.cwd(),
			placeholder: process.cwd(),
			validate: validateSpawnCwdText,
		});
		if (cwd === undefined) return undefined;

		request = {
			slug: slug.trim(),
			task: task.trim(),
			harness,
			cwd: normalizedSpawnCwd(cwd),
		};
		return request;
	} finally {
		flow.end({ preserveDiagnostics: false });
	}
}

function formatSpawnWorkerConfig(config: ClankyConfig): string {
	return [
		"Spawn worker:",
		"harness: choose explicitly for this worker",
		`allowed harnesses: ${formatAllowedHarnesses(config)}`,
		`default cwd: ${displayHomePath(process.cwd())}`,
	].join("\n");
}

function spawnHarnessOptions(config: ClankyConfig): readonly MenuOption[] {
	const allowed = configuredAllowedHarnesses(config);
	const explicit = CODING_HARNESS_OPTIONS.filter((option) => {
		const harness = parseCodingHarnessId(option.value);
		return harness !== undefined && allowed.includes(harness);
	});
	return explicit;
}

function validateSpawnSlugText(value: string): string | undefined {
	const trimmed = value.trim();
	if (trimmed.length === 0) return "Enter a worker slug.";
	if (!SPAWN_SLUG_RE.test(trimmed)) return "Use lowercase letters, digits, and hyphens; start with a letter or digit.";
	return undefined;
}

function requiredSpawnTaskText(value: string): string | undefined {
	return value.trim().length === 0 ? "Enter a task brief." : undefined;
}

function validateSpawnCwdText(value: string): string | undefined {
	return value.trim().length === 0 ? "Enter a host working directory, or keep the default." : undefined;
}

function normalizedSpawnCwd(value: string): string | undefined {
	const trimmed = value.trim();
	return trimmed === process.cwd() ? undefined : trimmed;
}

function normalizedOptionalText(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
}

function formatBrainHealthSummary(health: BrainHealthState): string {
	switch (health.state) {
		case "unknown":
			return `status unknown (${brainHost})`;
		case "restarting": {
			const detail = health.detail === undefined ? "" : `: ${health.detail}`;
			return `restarting (${brainHost})${detail}`;
		}
		case "healthy":
			return `healthy (${brainHost})`;
		case "unhealthy": {
			const statusText = health.statusText.length === 0 ? "" : ` ${health.statusText}`;
			const detail = health.detail === undefined ? "" : `: ${health.detail}`;
			return `unavailable ${health.status}${statusText} (${brainHost})${detail}`;
		}
		case "down":
			return `unreachable (${brainHost}): ${health.detail}`;
	}
}

function formatDiscordScopeSummary(config: ClankyConfig): string {
	return [
		statusInline("guilds", formatDiscordScopeList(config.discordAllowedGuildIds, "any")),
		statusInline("channels", formatDiscordScopeList(config.discordAllowedChannelIds, "any")),
		statusInline("dms", configBooleanDefaultTrue(config.discordAllowDms) ? "allowed" : "blocked", configBooleanDefaultTrue(config.discordAllowDms) ? "ok" : "warn"),
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
	allowBack = false,
	status?: SettingsMenuStatus,
): Promise<ClankyConfig["provider"] | undefined> {
	flow.begin("Configure Clanky model");
	let statusExpanded = false;
	let initial: string | undefined = initialValue;
	try {
		for (;;) {
			const statusSpec = typeof status === "object" ? status : undefined;
			const statusText =
				typeof status === "string"
					? status
					: statusSpec === undefined
						? undefined
						: statusExpanded
							? statusSpec.expanded
							: statusSpec.collapsed;
			const message =
				statusText !== undefined && statusText.length > 0
					? `${statusText}\n\nChoose the model provider Clanky should use.`
					: "Choose the model provider Clanky should use.";
			const options: readonly MenuOption[] = [
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
				{
					value: "xai",
					label: "xai",
					hint: "xAI Grok (CLANKY_XAI_API_KEY / XAI_API_KEY)",
				},
				{
					value: "gemini",
					label: "gemini",
					hint: "Google Gemini (CLANKY_GEMINI_API_KEY / GEMINI_API_KEY)",
				},
			];
			const selected = await selectOne(
				flow,
				message,
				options,
				initial,
				allowBack,
				undefined,
				statusSpec === undefined ? undefined : [settingsStatusToggleOption(statusSpec, statusExpanded)],
			);
			if (selected === undefined) return undefined;
			if (selected === SETTINGS_STATUS_TOGGLE_VALUE && statusSpec !== undefined) {
				statusExpanded = !statusExpanded;
				initial = SETTINGS_STATUS_TOGGLE_VALUE;
				continue;
			}
			return parseProvider(selected);
		}
	} finally {
		flow.end({ preserveDiagnostics: false });
	}
}

async function selectModel(
	flow: SetupFlow,
	provider: ClankyConfig["provider"],
	config: ClankyConfig,
	allowBack = false,
): Promise<string | undefined> {
	flow.begin(`Configure ${provider} model`);
	try {
		if (provider === "local") {
			const baseUrl = config.localBaseUrl ?? DEFAULT_LOCAL_BASE_URL;
			const options = await localModelOptions(baseUrl);
			return await selectOne(flow, `Choose the local model served at ${baseUrl}.`, options, config.localModel, allowBack);
		}
		if (provider === "xai") {
			return await selectOne(flow, "Choose the xAI Grok model Clanky should use.", XAI_MODEL_OPTIONS, config.xaiModel, allowBack);
		}
		if (provider === "gemini") {
			return await selectOne(flow, "Choose the Gemini model Clanky should use.", GEMINI_MODEL_OPTIONS, config.geminiModel, allowBack);
		}
		const current = provider === "codex" ? config.codexModel : config.claudeModel;
		return await selectOne(flow, "Choose the model Clanky should use.", MODEL_OPTIONS[provider], current, allowBack);
	} finally {
		flow.end({ preserveDiagnostics: false });
	}
}

// Prompt for an API-key-backed provider's key so it can be entered in the TUI
// instead of only via env. Returns the trimmed key to store, "keep" when the
// user submits blank (leave the existing key/env untouched), or undefined on
// cancel.
async function promptProviderApiKey(
	flow: SetupFlow,
	provider: "xai" | "gemini",
	config: ClankyConfig,
	allowBack = false,
): Promise<string | "keep" | undefined> {
	const label = provider === "xai" ? "xAI" : "Gemini";
	const envNames = provider === "xai" ? "CLANKY_XAI_API_KEY or XAI_API_KEY" : "CLANKY_GEMINI_API_KEY or GEMINI_API_KEY";
	const present = provider === "xai" ? config.xaiApiKeyPresent === true : config.geminiApiKeyPresent === true;
	flow.begin(`Set ${label} API key`);
	try {
		const value = await flow.readText({
			message: present
				? `Paste your ${label} API key (stored in .env.local). Leave blank to keep the current key.`
				: `Paste your ${label} API key (stored in .env.local). Leave blank to set ${envNames} yourself later.`,
			placeholder: `${label} API key`,
			allowBack,
		});
		if (value === undefined) return undefined;
		const trimmed = value.trim();
		return trimmed.length === 0 ? "keep" : trimmed;
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
	includeStatus = false,
	allowBack = false,
): Promise<string | undefined> {
	flow.begin("Configure Codex reasoning effort");
	try {
		return await selectOne(flow, "Choose the Codex reasoning effort.", includeStatus ? EFFORT_STATUS_OPTIONS : EFFORT_OPTIONS, includeStatus ? "status" : currentEffort, allowBack);
	} finally {
		flow.end({ preserveDiagnostics: false });
	}
}

async function selectLocalEffort(
	flow: SetupFlow,
	currentEffort: string | undefined,
	includeStatus = false,
): Promise<string | undefined> {
	flow.begin("Configure local reasoning effort");
	try {
		return await selectOne(flow, "Choose the local reasoning effort.", includeStatus ? LOCAL_EFFORT_STATUS_OPTIONS : LOCAL_EFFORT_OPTIONS, includeStatus ? "status" : currentEffort);
	} finally {
		flow.end({ preserveDiagnostics: false });
	}
}

async function selectOne(
	flow: SetupFlow,
	message: string,
	options: readonly MenuOption[],
	initialValue: string | undefined,
	allowBack = false,
	currentValue?: string,
	statusActions?: readonly MenuOption[],
): Promise<string | undefined> {
	const selected = await flow.readSelect({
		kind: "single",
		message,
		options,
		currentValue,
		initialValue,
		allowBack,
		statusActions,
	});
	return selected?.[0];
}

// Drives a settings menu: the top-level list re-shows after every drill-in so
// Left/Esc inside a sub-prompt returns here instead of closing the flow.
// `dispatch` returns a string to finish (apply + close) or undefined to stay
// on the menu (the user backed out, or chose a status/refresh-only action).
// The loop itself returns undefined when the user backs out of this menu, so
// nested menus compose: a sub-menu's back propagates to its parent.
async function settingsLoop(
	flow: SetupFlow,
	spec: {
		readonly title: string;
		readonly options: () => readonly MenuOption[];
		readonly renderStatus?: () => SettingsMenuStatus;
		readonly initial?: string;
		readonly dispatch: (value: string) => Promise<string | undefined>;
	},
): Promise<string | undefined> {
	let initial = spec.initial;
	let statusExpanded = false;
	for (;;) {
		// Render the live config inside the modal (above the prompt) so the menu is
		// self-describing; no separate "status" item that closes the menu is needed.
		const renderedStatus = spec.renderStatus?.();
		const statusSpec = typeof renderedStatus === "object" ? renderedStatus : undefined;
		const status =
			typeof renderedStatus === "string"
				? renderedStatus
				: statusSpec === undefined
					? undefined
					: statusExpanded
						? statusSpec.expanded
						: statusSpec.collapsed;
		const message = status !== undefined && status.length > 0 ? `${status}\n\n${spec.title}` : spec.title;
		const choice = await selectOne(
			flow,
			message,
			spec.options(),
			initial,
			true,
			undefined,
			statusSpec === undefined ? undefined : [settingsStatusToggleOption(statusSpec, statusExpanded)],
		);
		if (choice === undefined) return undefined;
		if (choice === SETTINGS_STATUS_TOGGLE_VALUE && statusSpec !== undefined) {
			statusExpanded = !statusExpanded;
			initial = SETTINGS_STATUS_TOGGLE_VALUE;
			continue;
		}
		initial = choice;
		const result = await spec.dispatch(choice);
		if (result !== undefined) return result;
	}
}

function collapsibleMenuStatus(collapsed: string, expanded: string): SettingsMenuStatus {
	return { collapsed, expanded };
}

function settingsStatusToggleOption(status: Exclude<SettingsMenuStatus, string>, expanded: boolean): MenuOption {
	const icon = expanded ? SETTINGS_STATUS_COLLAPSE_ICON : SETTINGS_STATUS_EXPAND_ICON;
	return {
		value: SETTINGS_STATUS_TOGGLE_VALUE,
		label: icon,
		description: expanded ? (status.collapseLabel ?? "hide details") : (status.expandLabel ?? "show details"),
	};
}

function formatVoiceConfig(config: ClankyConfig): string {
	const realtimeProvider = parseVoiceRealtimeProvider(config.voiceRealtimeProvider) ?? "openai";
	const memoryLimit = parseVoiceMemoryLimit(config.voiceMemoryContextLimit ?? "16") ?? 16;
	const eveSessionEnabled = parseVoiceToggle(config.voiceEveSession) ?? true;
	const discordVoiceEnabled = parseVoiceToggle(config.discordVoice) === true;
	const discordCredentialKind = config.discordCredentialKind === "user-token" ? "user-token" : "bot-token";
	const discordCredential = config.discordTokenPresent === true ? discordCredentialKind : "unset";
	const realtimeModel = voiceRealtimeModelLabel(config, realtimeProvider);
	const realtimeVoice = config.voiceRealtimeVoice ?? defaultRealtimeVoice(config);
	const ttsProvider = inferredVoiceTtsProvider(config);
	const lines = [
		statusTitle("Voice config"),
		"",
		statusSection("Discord"),
		statusLine("runtime", discordVoiceEnabled ? "on" : "off", discordVoiceEnabled ? "ok" : "muted"),
		statusLine("credential", discordCredential, config.discordTokenPresent === true ? "ok" : "warn"),
		"",
		statusSection("Realtime"),
		statusLine("mode", voiceModeLabel(realtimeProvider), realtimeProvider === "local" ? "ok" : "active"),
		statusLine("model", realtimeModel, "active"),
		statusLine("voice", realtimeVoice),
		statusLine("server", realtimeProvider === "local" ? (config.voiceLocalBaseUrl ?? config.localBaseUrl ?? DEFAULT_LOCAL_BASE_URL) : "hosted realtime provider", realtimeProvider === "local" ? "ok" : "active"),
		"",
		statusSection("TTS"),
		statusLine("provider", ttsProvider, ttsProvider === "realtime" ? "ok" : "active"),
		statusLine("ElevenLabs voice id", config.elevenLabsVoiceId ?? "(unset)", config.elevenLabsVoiceId === undefined ? "muted" : "ok"),
		statusLine("ElevenLabs model", config.elevenLabsTtsModel ?? "(default)", config.elevenLabsTtsModel === undefined ? "muted" : "ok"),
		"",
		statusSection("Memory"),
		statusLine("context limit", String(memoryLimit)),
		statusLine("Eve session", eveSessionEnabled ? "on" : "off", eveSessionEnabled ? "ok" : "muted"),
	];
	if (realtimeProvider === "local") {
		lines.push(
			"",
			statusSection("Local stack"),
			statusLine("ASR", `${config.voiceAsrCommand ?? "whisper-cli"} / ${config.voiceAsrModel ?? defaultVoiceAsrModelPath()}`),
			statusLine("LLM endpoint", config.voiceLocalBaseUrl ?? config.localBaseUrl ?? DEFAULT_LOCAL_BASE_URL, "ok"),
			statusLine("TTS engine", `${parseLocalTtsEngine(config.voiceLocalTtsEngine) ?? "say"}${config.voiceLocalTtsCommand === undefined ? "" : ` / ${config.voiceLocalTtsCommand}`}`),
		);
	}
	return lines.join("\n");
}

function formatVoiceMenuStatus(config: ClankyConfig): SettingsMenuStatus {
	return collapsibleMenuStatus(formatVoiceSummary(config), formatVoiceConfig(config));
}

function formatVoiceSummary(config: ClankyConfig): string {
	const realtimeProvider = parseVoiceRealtimeProvider(config.voiceRealtimeProvider) ?? "openai";
	const discordVoiceEnabled = parseVoiceToggle(config.discordVoice) === true;
	const discordCredentialKind = config.discordCredentialKind === "user-token" ? "user-token" : "bot-token";
	const discordCredential = config.discordTokenPresent === true ? discordCredentialKind : "unset";
	const memoryLimit = parseVoiceMemoryLimit(config.voiceMemoryContextLimit ?? "16") ?? 16;
	const lines = [
		statusTitle("Voice"),
		[
			statusInline("Discord", discordVoiceEnabled ? "on" : "off", discordVoiceEnabled ? "ok" : "muted"),
			statusInline("credential", discordCredential, config.discordTokenPresent === true ? "ok" : "warn"),
		].join("; "),
		[
			statusInline("Realtime", voiceModeLabel(realtimeProvider), realtimeProvider === "local" ? "ok" : "active"),
			statusInline("model", voiceRealtimeModelLabel(config, realtimeProvider), "active"),
			statusInline("voice", config.voiceRealtimeVoice ?? defaultRealtimeVoice(config)),
		].join("; "),
		[
			statusInline("TTS", inferredVoiceTtsProvider(config), "ok"),
			statusInline("memory", String(memoryLimit)),
			statusInline("Eve", (parseVoiceToggle(config.voiceEveSession) ?? true) ? "on" : "off", (parseVoiceToggle(config.voiceEveSession) ?? true) ? "ok" : "muted"),
		].join("; "),
	];
	if (realtimeProvider === "local") {
		lines.push(statusLine("Local endpoint", config.voiceLocalBaseUrl ?? config.localBaseUrl ?? DEFAULT_LOCAL_BASE_URL, "ok"));
	}
	return lines.join("\n");
}

function formatVoiceStatusLines(config: ClankyConfig): string[] {
	const realtimeProvider = parseVoiceRealtimeProvider(config.voiceRealtimeProvider) ?? "openai";
	const memoryLimit = parseVoiceMemoryLimit(config.voiceMemoryContextLimit ?? "16") ?? 16;
	const eveSessionEnabled = parseVoiceToggle(config.voiceEveSession) ?? true;
	const discordVoiceEnabled = parseVoiceToggle(config.discordVoice) === true;
	const discordCredentialKind = config.discordCredentialKind === "user-token" ? "user-token" : "bot-token";
	const discordCredential = config.discordTokenPresent === true ? discordCredentialKind : "unset";
	const lines = [
		statusLine("discord voice runtime", discordVoiceEnabled ? "on" : "off", discordVoiceEnabled ? "ok" : "muted"),
		statusLine("discord credential", discordCredential, config.discordTokenPresent === true ? "ok" : "warn"),
		statusLine("voice mode", voiceModeLabel(realtimeProvider), realtimeProvider === "local" ? "ok" : "active"),
		statusLine("voice realtime", `${voiceRealtimeModelLabel(config, realtimeProvider)} / voice ${config.voiceRealtimeVoice ?? defaultRealtimeVoice(config)}`, "active"),
		statusLine("voice tts", inferredVoiceTtsProvider(config), "ok"),
		statusLine("elevenlabs voice id", config.elevenLabsVoiceId ?? "(unset)", config.elevenLabsVoiceId === undefined ? "muted" : "ok"),
		statusLine("elevenlabs tts model", config.elevenLabsTtsModel ?? "(default)", config.elevenLabsTtsModel === undefined ? "muted" : "ok"),
		statusLine("voice memory context limit", String(memoryLimit)),
		statusLine("voice eve session", eveSessionEnabled ? "on" : "off", eveSessionEnabled ? "ok" : "muted"),
	];
	if (realtimeProvider === "local") {
		lines.splice(4, 0, statusLine("voice ASR", `${config.voiceAsrCommand ?? "whisper-cli"} / ${config.voiceAsrModel ?? defaultVoiceAsrModelPath()}`));
		lines.splice(5, 0, statusLine("voice local endpoint", config.voiceLocalBaseUrl ?? config.localBaseUrl ?? DEFAULT_LOCAL_BASE_URL, "ok"));
		lines.splice(6, 0, statusLine("voice local TTS", `${parseLocalTtsEngine(config.voiceLocalTtsEngine) ?? "say"}${config.voiceLocalTtsCommand === undefined ? "" : ` / ${config.voiceLocalTtsCommand}`}`));
	}
	return lines;
}

function voiceUsage(): string {
	return [
		"Usage:",
		"/voice",
		"/voice status",
		"/voice mode <openai|xai|local>",
		"/voice openai | xai | local",
		"/voice <elevenlabs-voice-id>",
		"/voice local-defaults",
		"/voice [mode|model|realtime-voice|tts|asr-model|asr-command|local-base-url|local-tts-engine|local-tts-command|elevenlabs|elevenlabs-model|memory|eve-session] [value]",
	].join("\n");
}

function voiceSettingUsage(setting: VoiceSetting): string {
	switch (setting) {
		case "mode":
			return "Usage: /voice mode <openai|xai|local>";
		case "realtime-provider":
			return "Usage: /voice realtime-provider <openai|xai|local> (same as /voice mode)";
		case "local-defaults":
			return "Usage: /voice local-defaults";
		case "realtime-model":
			return "Usage: /voice model <model-id>";
		case "realtime-voice":
			return "Usage: /voice realtime-voice <voice>";
		case "tts-provider":
			return "Usage: /voice tts <realtime|elevenlabs>";
		case "asr-model":
			return "Usage: /voice asr-model <whisper.cpp-model-path>";
		case "asr-command":
			return "Usage: /voice asr-command <command>";
		case "local-base-url":
			return "Usage: /voice local-base-url <openai-compatible-base-url>";
		case "local-tts-engine":
			return "Usage: /voice local-tts-engine <say|command>";
		case "local-tts-command":
			return "Usage: /voice local-tts-command <shell-command>";
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

function voiceModeLabel(provider: VoiceRealtimeProvider): string {
	if (provider === "local") return "local (Whisper + local LLM + local TTS)";
	return provider === "xai" ? "provider (xAI realtime)" : "provider (OpenAI realtime)";
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
		case "stack":
		case "source":
		case "provider":
			return "mode";
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
		case "asr":
		case "asrmodel":
		case "whisper":
		case "whispermodel":
			return "asr-model";
		case "asrcommand":
		case "whispercommand":
			return "asr-command";
		case "localbaseurl":
		case "localendpoint":
		case "localvoiceendpoint":
			return "local-base-url";
		case "localtts":
		case "localttsengine":
			return "local-tts-engine";
		case "localttscommand":
		case "ttscommand":
			return "local-tts-command";
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
	if (normalized === "local") return "local";
	return undefined;
}

function parseVoiceTtsProvider(value: string | undefined): VoiceTtsProvider | undefined {
	const normalized = value?.trim().toLowerCase();
	if (normalized === "realtime" || normalized === "native") return "realtime";
	if (normalized === "elevenlabs" || normalized === "11labs") return "elevenlabs";
	return undefined;
}

function parseLocalTtsEngine(value: string | undefined): "say" | "command" | undefined {
	const normalized = value?.trim().toLowerCase();
	if (normalized === "say" || normalized === "macos") return "say";
	if (normalized === "command" || normalized === "cmd") return "command";
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
	return defaultRealtimeModelForProvider(parseVoiceRealtimeProvider(config.voiceRealtimeProvider) ?? "openai");
}

function voiceRealtimeModelLabel(config: ClankyConfig, provider: VoiceRealtimeProvider): string {
	const defaultModel = defaultRealtimeModelForProvider(provider);
	const configured = config.voiceRealtimeModel?.trim();
	if (configured === undefined || configured.length === 0) return defaultModel;
	if (!realtimeModelMatchesProvider(provider, configured)) return `${defaultModel} (ignoring incompatible override ${configured})`;
	return configured !== defaultModel ? `${configured} (configured override; default ${defaultModel})` : configured;
}

function defaultRealtimeModelForProvider(provider: VoiceRealtimeProvider): string {
	if (provider === "local") return DEFAULT_LOCAL_VOICE_LLM_MODEL;
	return provider === "xai" ? "grok-voice-2" : "gpt-realtime";
}

function realtimeModelMatchesProvider(provider: VoiceRealtimeProvider, model: string): boolean {
	if (provider === "local") return true;
	const normalized = model.trim().toLowerCase();
	return provider === "xai" ? normalized.startsWith("grok-") : normalized.startsWith("gpt-") || normalized.startsWith("o");
}

function defaultRealtimeVoice(config: ClankyConfig): string {
	return defaultRealtimeVoiceForProvider(parseVoiceRealtimeProvider(config.voiceRealtimeProvider) ?? "openai");
}

function defaultRealtimeVoiceForProvider(provider: VoiceRealtimeProvider): string {
	return provider === "local" ? DEFAULT_LOCAL_VOICE : "marin";
}

function defaultVoiceAsrModelPath(): string {
	return resolveClankyDataPath(DEFAULT_LOCAL_VOICE_ASR_MODEL);
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
	const xaiModel = get("CLANKY_XAI_MODEL");
	const geminiModel = get("CLANKY_GEMINI_MODEL");
	const xaiApiKey = get("CLANKY_XAI_API_KEY") ?? get("XAI_API_KEY") ?? process.env.CLANKY_XAI_API_KEY ?? process.env.XAI_API_KEY;
	const geminiApiKey =
		get("CLANKY_GEMINI_API_KEY") ??
		get("GEMINI_API_KEY") ??
		get("GOOGLE_GENERATIVE_AI_API_KEY") ??
		process.env.CLANKY_GEMINI_API_KEY ??
		process.env.GEMINI_API_KEY ??
		process.env.GOOGLE_GENERATIVE_AI_API_KEY;
	const openAiApiKey = get("CLANKY_OPENAI_API_KEY") ?? get("OPENAI_API_KEY") ?? process.env.CLANKY_OPENAI_API_KEY ?? process.env.OPENAI_API_KEY;
	const elevenLabsApiKey =
		get("CLANKY_ELEVENLABS_API_KEY") ??
		get("ELEVENLABS_API_KEY") ??
		process.env.CLANKY_ELEVENLABS_API_KEY ??
		process.env.ELEVENLABS_API_KEY;
	const relayToken = get("CLANKY_RELAY_TOKEN") ?? process.env.CLANKY_RELAY_TOKEN;
	const voiceLocalApiKey = get("CLANKY_VOICE_LOCAL_API_KEY") ?? process.env.CLANKY_VOICE_LOCAL_API_KEY;
	const visionModel = get("CLANKY_VISION_MODEL");
	const visionEnabled = get("CLANKY_VISION_ENABLED");
	const visionProvider = get("CLANKY_VISION_PROVIDER");
		const openAiVisionModel = get("CLANKY_OPENAI_VISION_MODEL");
		const autoApprove = get("CLANKY_AUTO_APPROVE");
		const agentMd = get(CLANKY_AGENT_MD_ENV);
		const agentMdRoot = get(CLANKY_AGENT_MD_ROOT_ENV);
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
	const xaiImageModel = get("CLANKY_XAI_IMAGE_MODEL");
	const geminiImageModel = get("CLANKY_GEMINI_IMAGE_MODEL");
	const imageProvider = get("CLANKY_IMAGE_PROVIDER");
	const videoProvider = get("CLANKY_VIDEO_PROVIDER");
	const xaiVideoModel = get("CLANKY_XAI_VIDEO_MODEL");
	const voiceRealtimeProvider = get("CLANKY_VOICE_REALTIME_PROVIDER");
	const voiceRealtimeModel = get("CLANKY_VOICE_REALTIME_MODEL");
	const voiceRealtimeVoice = get("CLANKY_VOICE_REALTIME_VOICE");
	const voiceTtsProvider = get("CLANKY_VOICE_TTS_PROVIDER");
	const voiceAsrModel = get("CLANKY_VOICE_ASR_MODEL");
	const voiceAsrCommand = get("CLANKY_VOICE_ASR_COMMAND");
	const voiceLocalBaseUrl = get("CLANKY_VOICE_LOCAL_BASE_URL");
	const voiceLocalTtsEngine = get("CLANKY_VOICE_LOCAL_TTS_ENGINE");
	const voiceLocalTtsCommand = get("CLANKY_VOICE_LOCAL_TTS_COMMAND");
	const elevenLabsVoiceId = get("CLANKY_ELEVENLABS_VOICE_ID");
		const elevenLabsTtsModel = get("CLANKY_ELEVENLABS_TTS_MODEL");
		const voiceMemoryContextLimit = get("CLANKY_VOICE_MEMORY_CONTEXT_LIMIT");
		const voiceEveSession = get("CLANKY_VOICE_EVE_SESSION");
		const discordCredentialKind = get("CLANKY_DISCORD_CREDENTIAL_KIND");
		const discordVoice = get("CLANKY_DISCORD_VOICE");
		const discordToken = get("CLANKY_DISCORD_TOKEN") ?? get("DISCORD_BOT_TOKEN");
		const discordAllowedGuildIds = get(DISCORD_SCOPE_ENV.guilds);
		const discordAllowedChannelIds = get(DISCORD_SCOPE_ENV.channels);
		const discordAllowDms = get(DISCORD_SCOPE_ENV.dms);
		const apnsKeyPath = get(PUSH_APNS_ENV.keyPath) ?? get(PUSH_APNS_ENV.keyAlias) ?? process.env[PUSH_APNS_ENV.keyPath] ?? process.env[PUSH_APNS_ENV.keyAlias];
		const apnsKeyId = get(PUSH_APNS_ENV.keyId) ?? process.env[PUSH_APNS_ENV.keyId];
		const apnsTeamId = get(PUSH_APNS_ENV.teamId) ?? process.env[PUSH_APNS_ENV.teamId];
		const apnsBundleId = get(PUSH_APNS_ENV.bundleId) ?? process.env[PUSH_APNS_ENV.bundleId];
		const apnsEnvironment = get(PUSH_APNS_ENV.environment) ?? process.env[PUSH_APNS_ENV.environment];
	if (codexModel !== undefined) config.codexModel = codexModel;
	if (claudeModel !== undefined) config.claudeModel = claudeModel;
	if (codexEffort !== undefined) config.codexEffort = codexEffort;
	if (localModel !== undefined) config.localModel = localModel;
	if (xaiModel !== undefined) config.xaiModel = xaiModel;
	if (geminiModel !== undefined) config.geminiModel = geminiModel;
	if (xaiApiKey !== undefined) config.xaiApiKeyPresent = xaiApiKey.trim().length > 0;
	if (geminiApiKey !== undefined) config.geminiApiKeyPresent = geminiApiKey.trim().length > 0;
	if (openAiApiKey !== undefined) config.openAiApiKeyPresent = openAiApiKey.trim().length > 0;
	if (elevenLabsApiKey !== undefined) config.elevenLabsApiKeyPresent = elevenLabsApiKey.trim().length > 0;
	if (relayToken !== undefined) config.relayTokenPresent = relayToken.trim().length > 0;
	if (voiceLocalApiKey !== undefined) config.voiceLocalApiKeyPresent = voiceLocalApiKey.trim().length > 0;
	if (localBaseUrl !== undefined) config.localBaseUrl = localBaseUrl;
	if (localEffort !== undefined) config.localEffort = localEffort;
	if (localContextTokens !== undefined) config.localContextTokens = localContextTokens;
	if (visionModel !== undefined) config.visionModel = visionModel;
	if (visionEnabled !== undefined) config.visionEnabled = visionEnabled;
	if (visionProvider !== undefined) config.visionProvider = visionProvider;
		if (openAiVisionModel !== undefined) config.openAiVisionModel = openAiVisionModel;
		if (autoApprove !== undefined) config.autoApprove = autoApprove;
		if (agentMd !== undefined) config.agentMd = agentMd;
		if (agentMdRoot !== undefined) config.agentMdRoot = agentMdRoot;
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
	if (xaiImageModel !== undefined) config.xaiImageModel = xaiImageModel;
	if (geminiImageModel !== undefined) config.geminiImageModel = geminiImageModel;
	if (imageProvider !== undefined) config.imageProvider = imageProvider;
	if (videoProvider !== undefined) config.videoProvider = videoProvider;
	if (xaiVideoModel !== undefined) config.xaiVideoModel = xaiVideoModel;
	if (voiceRealtimeProvider !== undefined) config.voiceRealtimeProvider = voiceRealtimeProvider;
	if (voiceRealtimeModel !== undefined) config.voiceRealtimeModel = voiceRealtimeModel;
	if (voiceRealtimeVoice !== undefined) config.voiceRealtimeVoice = voiceRealtimeVoice;
	if (voiceTtsProvider !== undefined) config.voiceTtsProvider = voiceTtsProvider;
	if (voiceAsrModel !== undefined) config.voiceAsrModel = voiceAsrModel;
	if (voiceAsrCommand !== undefined) config.voiceAsrCommand = voiceAsrCommand;
	if (voiceLocalBaseUrl !== undefined) config.voiceLocalBaseUrl = voiceLocalBaseUrl;
	if (voiceLocalTtsEngine !== undefined) config.voiceLocalTtsEngine = voiceLocalTtsEngine;
	if (voiceLocalTtsCommand !== undefined) config.voiceLocalTtsCommand = voiceLocalTtsCommand;
	if (elevenLabsVoiceId !== undefined) config.elevenLabsVoiceId = elevenLabsVoiceId;
		if (elevenLabsTtsModel !== undefined) config.elevenLabsTtsModel = elevenLabsTtsModel;
		if (voiceMemoryContextLimit !== undefined) config.voiceMemoryContextLimit = voiceMemoryContextLimit;
		if (voiceEveSession !== undefined) config.voiceEveSession = voiceEveSession;
		if (discordCredentialKind !== undefined) config.discordCredentialKind = discordCredentialKind;
		if (discordVoice !== undefined) config.discordVoice = discordVoice;
		if (discordToken !== undefined) config.discordTokenPresent = discordToken.trim().length > 0;
		if (discordAllowedGuildIds !== undefined) config.discordAllowedGuildIds = discordAllowedGuildIds;
	if (discordAllowedChannelIds !== undefined) config.discordAllowedChannelIds = discordAllowedChannelIds;
	if (discordAllowDms !== undefined) config.discordAllowDms = discordAllowDms;
	if (apnsKeyPath !== undefined) config.apnsKeyPath = apnsKeyPath;
	if (apnsKeyId !== undefined) config.apnsKeyId = apnsKeyId;
	if (apnsTeamId !== undefined) config.apnsTeamId = apnsTeamId;
	if (apnsBundleId !== undefined) config.apnsBundleId = apnsBundleId;
	if (apnsEnvironment !== undefined) config.apnsEnvironment = apnsEnvironment;
	return config;
}

async function readFaceEnv(): Promise<NodeJS.ProcessEnv> {
	const content = await readFile(ENV_PATH, "utf8").catch(() => "");
	const fileEnv = content.trim().length === 0 ? {} : parseEnv(content);
	return { ...fileEnv, ...process.env };
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
		const attachedRestart = await restartAttachedDevServerMessage();
		if (attachedRestart !== undefined) return appendRestartSentence(prefix, attachedRestart);
		return appendRestartSentence(prefix, "Saved .env.local; attached to an external eve server, so restart it to apply.");
	}

	const preservedSession = await preserveCurrentSessionForRestart();
	brainRestartInProgress = true;
	brainHealthGeneration += 1;
	stopBrainHealthMonitor();
	setBrainHealth({ state: "restarting", checkedAt: Date.now(), detail: "applying configuration" });
	refreshStatus("restarting");

	try {
		await stopServer({ stopTimeoutMs: INTENTIONAL_RESTART_STOP_TIMEOUT_MS });
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
	restorePreservedSession(preservedSession);
	forwardServerOutput = true;
	startBrainHealthMonitor();
	refreshStatus("ready");
	return appendRestartSentence(prefix, restartCompleteSentence(preservedSession, "Restarted Clanky."));
}

function appendRestartSentence(prefix: string, sentence: string): string {
	const trimmed = prefix.trim();
	return `${trimmed}${/[.!?]$/u.test(trimmed) ? " " : ". "}${sentence}`;
}

async function restartAttachedDevServerMessage(): Promise<string | undefined> {
	const discovered = await discoverDevServerHost();
	if (discovered === undefined || !sameHost(discovered.host, brainHost)) return undefined;
	if (!canRestartAttachedDevServer(discovered.record)) return undefined;

	const preservedSession = await preserveCurrentSessionForRestart();
	brainRestartInProgress = true;
	brainHealthGeneration += 1;
	stopBrainHealthMonitor();
	setBrainHealth({ state: "restarting", checkedAt: Date.now(), detail: "applying configuration" });
	refreshStatus("restarting");

	try {
		await stopDevServerRecord(discovered.record, "restart");
		const restarted = await waitForAttachedDevServerRestart(discovered);
		if (!restarted) throw new Error(`Eve dev server did not come back healthy on ${discovered.host}`);
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		brainRestartInProgress = false;
		brainHealthGeneration += 1;
		setBrainHealth({ state: "down", checkedAt: Date.now(), detail });
		startBrainHealthMonitor();
		refreshStatus("ready");
		return `Saved .env.local, but restarting the attached Eve dev server failed: ${detail}`;
	}

	brainRestartInProgress = false;
	brainHealthGeneration += 1;
	const info = await fetchInfo();
	if (info !== undefined) updateLatestInfo(info);
	restorePreservedSession(preservedSession);
	startBrainHealthMonitor();
	refreshStatus("ready");
	return restartCompleteSentence(preservedSession, "Restarted the attached Eve dev server.");
}

async function preserveCurrentSessionForRestart(): Promise<SessionState | undefined> {
	const state = session.state;
	if (sessionStateId(state) === undefined) return undefined;
	await persistCurrentFaceSession({ label: currentSessionLabel });
	return { ...state };
}

function restorePreservedSession(state: SessionState | undefined): void {
	if (state === undefined) return;
	session = client.session(state);
}

function restartCompleteSentence(state: SessionState | undefined, sentence: string): string {
	return state === undefined ? sentence : `${sentence} Kept the current session.`;
}

async function waitForAttachedDevServerRestart(discovered: DiscoveredHost): Promise<boolean> {
	const targetHost = discovered.host;
	const oldPid = discovered.record.pid;
	const deadline = Date.now() + HEALTH_TIMEOUT_MS;
	while (Date.now() < deadline) {
		if (!isPidAlive(oldPid) && (await probe(targetHost)) === "healthy") return true;
		await new Promise((resolve) => setTimeout(resolve, DEV_SERVER_RECORD_REPROBE_MS));
	}
	return false;
}

function canRestartAttachedDevServer(record: DevServerRecord): boolean {
	if (parseBooleanFlag(process.env.CLANKY_RESTART_ATTACHED_EVE) === true) return true;
	const parent = parentPid(record.pid);
	return parent !== undefined && processAncestorPids().has(parent);
}

function processAncestorPids(pid = process.pid): Set<number> {
	const ancestors = new Set<number>();
	let current = pid;
	for (let depth = 0; depth < 32; depth += 1) {
		const parent = parentPid(current);
		if (parent === undefined || parent <= 1 || ancestors.has(parent)) break;
		ancestors.add(parent);
		current = parent;
	}
	return ancestors;
}

function parentPid(pid: number): number | undefined {
	try {
		const output = execFileSync("ps", ["-o", "ppid=", "-p", String(pid)], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
			timeout: 1000,
		}).trim();
		const parsed = Number.parseInt(output, 10);
		return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
	} catch {
		return undefined;
	}
}

function sameHost(left: string, right: string): boolean {
	const normalizedLeft = normalizeHost(left);
	const normalizedRight = normalizeHost(right);
	return normalizedLeft !== undefined && normalizedLeft === normalizedRight;
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
	const source = `.eve/dev-server.json pid ${record.pid}${record.updatedAt === undefined ? "" : ` updated ${record.updatedAt}`}`;
	const initialState = await probe(host);
	if (initialState === "healthy" || initialState === "reachable") return { host, record, source, state: initialState };

	const graceMs = devServerRecordStartupGraceMs(record);
	if (graceMs <= 0) return undefined;
	const deadline = Date.now() + graceMs;
	while (Date.now() < deadline && isPidAlive(record.pid)) {
		await new Promise((resolve) => setTimeout(resolve, Math.min(DEV_SERVER_RECORD_REPROBE_MS, Math.max(0, deadline - Date.now()))));
		const state = await probe(host);
		if (state === "healthy" || state === "reachable") return { host, record, source, state };
	}
	return undefined;
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

async function waitForDiscoveredDevServerHealth(discovered: DiscoveredHost): Promise<boolean> {
	const graceMs = Math.max(DEV_SERVER_UNHEALTHY_SETTLE_MS, devServerRecordStartupGraceMs(discovered.record));
	return await waitForHostHealth(discovered.host, graceMs, () => isPidAlive(discovered.record.pid));
}

async function waitForHostHealth(host: string, timeoutMs: number, shouldContinue: () => boolean = () => true): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline && shouldContinue()) {
		await new Promise((resolve) => setTimeout(resolve, Math.min(DEV_SERVER_RECORD_REPROBE_MS, Math.max(0, deadline - Date.now()))));
		if ((await probe(host)) === "healthy") return true;
	}
	return false;
}

function devServerRecordStartupGraceMs(record: DevServerRecord): number {
	if (record.updatedAt === undefined) return 0;
	const updatedAt = Date.parse(record.updatedAt);
	if (!Number.isFinite(updatedAt)) return 0;
	const ageMs = Math.max(0, Date.now() - updatedAt);
	return Math.max(0, DEV_SERVER_RECORD_STARTUP_GRACE_MS - ageMs);
}

async function stopDevServerRecord(record: DevServerRecord, reason: "restart" | "unhealthy"): Promise<void> {
	if (record.pid === process.pid) return;
	try {
		process.kill(record.pid, "SIGTERM");
	} catch {
		return;
	}
	const stopTimeoutMs = reason === "restart" ? INTENTIONAL_RESTART_STOP_TIMEOUT_MS : SERVER_STOP_TIMEOUT_MS;
	if (await waitForPidExit(record.pid, stopTimeoutMs)) return;
	if (reason !== "restart") {
		process.stderr.write(`  \x1b[33m${reason} Eve dev server pid ${record.pid} did not exit after SIGTERM; forcing stop\x1b[39m\n`);
	}
	try {
		process.kill(record.pid, "SIGKILL");
	} catch {
		return;
	}
	await waitForPidExit(record.pid, SERVER_KILL_TIMEOUT_MS);
}

async function waitForPidExit(pid: number, timeoutMs: number): Promise<boolean> {
	if (!isPidAlive(pid)) return true;
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		await new Promise((resolve) => setTimeout(resolve, 100));
		if (!isPidAlive(pid)) return true;
	}
	return false;
}

async function startServer(): Promise<void> {
	forwardServerOutput = false;
	ownedServerStartupOutput = "";
	ownedServerStartError = undefined;
	brainHost = HOST;
	const env = await buildOwnedServerEnv();
	const args = [
		"dev",
		"--no-ui",
		...(BIND_HOST === undefined || BIND_HOST.length === 0 ? [] : ["--host", BIND_HOST]),
		"--port",
		String(PORT),
	];
	const child = spawn(join(REPO, "node_modules", ".bin", "eve"), args, {
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
	startupModelFallback = missingApiKeyStartupFallback(config);
	if (startupModelFallback !== undefined) {
		env.CLANKY_MODEL_PROVIDER = "codex";
		env[CLANKY_STARTUP_MODEL_FALLBACK_PROVIDER_ENV] = startupModelFallback.provider;
		env[CLANKY_STARTUP_MODEL_FALLBACK_ENV_NAMES_ENV] = startupModelFallback.envNames;
	}
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

function missingApiKeyStartupFallback(config: ClankyConfig): StartupModelFallback | undefined {
	if (config.provider === "xai" && config.xaiApiKeyPresent !== true) {
		return { provider: "xai", envNames: "CLANKY_XAI_API_KEY or XAI_API_KEY" };
	}
	if (config.provider === "gemini" && config.geminiApiKeyPresent !== true) {
		return { provider: "gemini", envNames: "CLANKY_GEMINI_API_KEY, GEMINI_API_KEY, or GOOGLE_GENERATIVE_AI_API_KEY" };
	}
	return undefined;
}

function formatStartupModelFallbackNotice(fallback: StartupModelFallback): string {
	const command = fallback.provider === "xai" ? "/model xai" : "/model gemini";
	return [
		"**Model provider needs an API key**",
		"",
		`.env.local selects \`${fallback.provider}\` for Clanky's brain, but ${fallback.envNames} is not set.`,
		"Clanky started this face with a temporary Codex brain so you can fix it from the TUI.",
		"",
		`Run \`${command}\` and paste the key, or switch to another brain with \`/model codex\`, \`/model claude\`, or \`/model local\`.`,
	].join("\n");
}

function startupModelFallbackFromEnv(env: NodeJS.ProcessEnv): StartupModelFallback | undefined {
	const provider = env[CLANKY_STARTUP_MODEL_FALLBACK_PROVIDER_ENV];
	const envNames = env[CLANKY_STARTUP_MODEL_FALLBACK_ENV_NAMES_ENV]?.trim();
	if ((provider !== "xai" && provider !== "gemini") || envNames === undefined || envNames.length === 0) return undefined;
	return { provider, envNames };
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
	if (!forwardServerOutput || !uiReady) return;
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
		if (discovered.state === "healthy") return false;
		if (discovered.state === "reachable") {
			process.stdout.write(`  \x1b[2mdev server ${brainHost} is reachable but not ready; waiting...\x1b[22m\n`);
			if (await waitForDiscoveredDevServerHealth(discovered)) return false;
			process.stdout.write(`  \x1b[33mdev server ${brainHost} stayed unhealthy; restarting ${discovered.source} for this face.\x1b[39m\n`);
			await stopDevServerRecord(discovered.record, "unhealthy");
			await startServer();
			await waitForHealth();
			return true;
		}
	}

	brainHost = HOST;
	const initial = await probe(HOST);
	if (initial === "healthy") return false;
	if (initial === "reachable") {
		process.stdout.write(`  \x1b[2ma server is on ${HOST} but not ready yet; waiting...\x1b[22m\n`);
		if (await waitForHostHealth(HOST, DEV_SERVER_UNHEALTHY_SETTLE_MS)) {
			return false;
		}
		throw new Error(`${HOST} is reachable but unhealthy, and no live ${DEV_SERVER_FILE} process was available to restart`);
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

async function stopServer(options: { readonly stopTimeoutMs?: number } = {}): Promise<void> {
	const child = server;
	server = null;
	forwardServerOutput = false;
	if (child === null || hasChildExited(child)) return;
	child.kill("SIGTERM");
	if (await waitForChildExit(child, options.stopTimeoutMs ?? SERVER_STOP_TIMEOUT_MS)) return;
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


try {
	await new Promise<void>(() => {});
} finally {
	process.off("SIGINT", handleProcessShutdownSignal);
	process.off("SIGTERM", handleProcessShutdownSignal);
	stopBrainHealthMonitor();
	disableClankyMouseTracking();
	tui.stop();
	await reportClankyFaceToHerdr("unknown", "Clanky face stopped");
	await stopCallbackProxy();
	if (ownsServer) await stopServer();
}
