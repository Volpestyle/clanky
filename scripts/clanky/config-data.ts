/**
 * Static configuration data for the Clanky face: model/value defaults, env-key
 * maps, and the menu option tables rendered by the settings menus.
 *
 * Pure data only — no runtime singletons, no side effects. Extracted from
 * scripts/clanky.ts to keep the face entrypoint navigable (SPEC.md §4.2).
 */
import { BUILTIN_CODING_HARNESSES } from "../../agent/lib/coding-harness.ts";

export type SubscriptionProvider = "codex" | "claude";
export const DEFAULT_CODEX_MODEL = "gpt-5.5";
export const DEFAULT_CLAUDE_MODEL = "claude-opus-4-8";
export const DEFAULT_LOCAL_MODEL = "qwen3-coder-next";
export const DEFAULT_LOCAL_BASE_URL = "http://127.0.0.1:11434/v1";
export const DEFAULT_LOCAL_VOICE_LLM_MODEL = "qwen3.6:27b-mlx";
export const DEFAULT_LOCAL_VOICE_ASR_MODEL = "models/voice/whisper/ggml-large-v3-turbo.bin";
export const DEFAULT_LOCAL_VOICE = "Samantha";
// Tiered all-local stack defaults: a 4-bit conductor shared by the main thread and
// Discord, and a small, low-latency voice model on a separate inference server so a
// long conductor turn never stalls the realtime voice loop.
export const DEFAULT_LOCAL_CONDUCTOR_MODEL = "qwen3.6:27b-mlx";
export const DEFAULT_LOCAL_VOICE_SMALL_MODEL = "qwen3-vl:8b";
export const DEFAULT_LOCAL_VOICE_SERVER_BASE_URL = "http://127.0.0.1:11435/v1";
export const DISCORD_SCOPE_ENV = {
	guilds: "CLANKY_DISCORD_ALLOWED_GUILD_IDS",
	channels: "CLANKY_DISCORD_ALLOWED_CHANNEL_IDS",
	dms: "CLANKY_DISCORD_ALLOW_DMS",
} as const;
export const PUSH_APNS_ENV = {
	keyPath: "CLANKY_APNS_KEY_PATH",
	keyAlias: "CLANKY_APNS_KEY",
	keyId: "CLANKY_APNS_KEY_ID",
	teamId: "CLANKY_APNS_TEAM_ID",
	bundleId: "CLANKY_APNS_BUNDLE_ID",
	environment: "CLANKY_APNS_ENV",
} as const;
export const PUSH_FCM_ENV = {
	serviceAccountPath: "CLANKY_FCM_SERVICE_ACCOUNT_PATH",
	projectId: "CLANKY_FCM_PROJECT_ID",
	clientEmail: "CLANKY_FCM_CLIENT_EMAIL",
	privateKey: "CLANKY_FCM_PRIVATE_KEY",
	tokenUri: "CLANKY_FCM_TOKEN_URI",
	googleApplicationCredentials: "GOOGLE_APPLICATION_CREDENTIALS",
} as const;
export const DEFAULT_APNS_BUNDLE_ID = "io.clanky.ios";
export const DEFAULT_APNS_ENVIRONMENT = "sandbox";

export type MenuOption = {
	value: string;
	label: string;
	hint?: string;
	description?: string;
};

export const EFFORT_LEVELS = ["minimal", "low", "medium", "high", "xhigh"] as const;
export const LOCAL_EFFORT_LEVELS = ["low", "medium", "high"] as const;
export const VOICE_SETTINGS = [
	"mode",
	"local-defaults",
	"realtime-provider",
	"realtime-model",
	"realtime-voice",
	"tts-provider",
	"asr-model",
	"asr-command",
	"local-base-url",
	"local-tts-engine",
	"local-tts-command",
	"elevenlabs-voice",
	"elevenlabs-model",
	"memory-limit",
	"eve-session",
] as const;
export type VoiceSetting = (typeof VOICE_SETTINGS)[number];
export type VoiceRealtimeProvider = "openai" | "xai" | "local";
export type VoiceTtsProvider = "realtime" | "elevenlabs";
export type VoiceSettingUpdate = {
	updates: Record<string, string>;
	message: string;
};
export type ImageModelUpdate = {
	updates: Record<string, string>;
	message: string;
};
export type DiscordTokenUpdate = {
	updates: Record<string, string>;
	message: string;
};
export type DiscordScopeUpdate = {
	updates: Record<string, string>;
	removals: string[];
	message: string;
};
export type AuthAction =
	| "status"
	| "codex"
	| "claude"
	| "xai"
	| "gemini"
	| "openai"
	| "discord"
	| "mcp"
	| "elevenlabs"
	| "relay"
	| "local-voice"
	| "login";
export type MenuBackOptions = {
	readonly backReturnsToMenu?: boolean;
};
export type AuthSecretAction = "openai" | "elevenlabs" | "relay" | "local-voice";
export type SubscriptionLoginPromptResult =
	| { readonly state: "ready"; readonly message?: string }
	| { readonly state: "skip" }
	| { readonly state: "cancelled"; readonly message: string };
export type McpCommandAction = "status" | "list" | "add" | "remove" | "enable" | "disable" | "auth" | "install" | "connections" | "help";
export type PushCommandAction = "status" | "key-path" | "key-id" | "team-id" | "bundle-id" | "env" | "test" | "clear" | "help";
export type PushApnsEnvironment = "sandbox" | "production";
export const MODEL_OPTIONS: Record<SubscriptionProvider, readonly MenuOption[]> = {
	codex: [
		{ value: "gpt-5.5", label: "gpt-5.5" },
		{ value: "gpt-5.4", label: "gpt-5.4" },
		{ value: "gpt-5.3-codex-spark", label: "gpt-5.3-codex-spark" },
		{ value: "keep-current", label: "keep current" },
	],
	claude: [
		{ value: "claude-opus-4-8", label: "claude-opus-4-8", hint: "flagship" },
		{ value: "claude-sonnet-4-6", label: "claude-sonnet-4-6" },
		{ value: "keep-current", label: "keep current" },
	],
};
export const DEFAULT_XAI_MODEL = "grok-4";
export const DEFAULT_GEMINI_MODEL = "gemini-3-pro";
export const XAI_MODEL_OPTIONS: readonly MenuOption[] = [
	{ value: "grok-4", label: "grok-4", hint: "flagship, vision" },
	{ value: "grok-4-fast", label: "grok-4-fast" },
	{ value: "grok-3", label: "grok-3" },
	{ value: "keep-current", label: "keep current" },
];
export const GEMINI_MODEL_OPTIONS: readonly MenuOption[] = [
	{ value: "gemini-3-pro", label: "gemini-3-pro", hint: "flagship, vision" },
	{ value: "gemini-2.5-pro", label: "gemini-2.5-pro", hint: "vision" },
	{ value: "gemini-2.5-flash", label: "gemini-2.5-flash" },
	{ value: "keep-current", label: "keep current" },
];
export const MODEL_ENV_KEY: Record<"codex" | "claude" | "xai" | "gemini", string> = {
	codex: "CLANKY_CODEX_MODEL",
	claude: "CLANKY_CLAUDE_MODEL",
	xai: "CLANKY_XAI_MODEL",
	gemini: "CLANKY_GEMINI_MODEL",
};
export const EFFORT_OPTIONS: readonly MenuOption[] = [
	{ value: "minimal", label: "minimal", hint: "fastest" },
	{ value: "low", label: "low" },
	{ value: "medium", label: "medium" },
	{ value: "high", label: "high" },
	{ value: "xhigh", label: "xhigh", hint: "deepest" },
	{ value: "keep-current", label: "keep current" },
];
export const EFFORT_STATUS_OPTIONS: readonly MenuOption[] = [
	{ value: "status", label: "status", hint: "show current effort" },
	...EFFORT_OPTIONS,
];
export const LOCAL_EFFORT_OPTIONS: readonly MenuOption[] = [
	{ value: "low", label: "low" },
	{ value: "medium", label: "medium" },
	{ value: "high", label: "high", hint: "deepest" },
	{ value: "unset", label: "unset", hint: "no reasoning_effort / server default" },
	{ value: "keep-current", label: "keep current" },
];
export const LOCAL_EFFORT_STATUS_OPTIONS: readonly MenuOption[] = [
	{ value: "status", label: "status", hint: "show current effort" },
	...LOCAL_EFFORT_OPTIONS,
];
export const PROFILE_OPTIONS: readonly MenuOption[] = [
	{ value: "local-tiered", label: "local tiered", hint: "local conductor + separate local voice server" },
	{ value: "local-single", label: "local single", hint: "one local model for conductor and voice" },
	{ value: "api", label: "api", hint: "hosted/API conductor + hosted realtime voice API" },
	{ value: "local-api", label: "local + API voice", hint: "local conductor + hosted realtime voice API" },
	{ value: "api-local", label: "API + local voice", hint: "hosted/API conductor + local voice stack" },
];
// Top-level voice menu: a short list of categories instead of 15 flat settings.
// Most entries drill into a grouped submenu (group:*); "mode" is common enough
// to drill straight to its picker.
export const VOICE_GROUP_OPTIONS: readonly MenuOption[] = [
	{ value: "mode", label: "voice mode", hint: "realtime provider or local stack" },
	{ value: "group:realtime", label: "realtime voice", hint: "model and provider voice" },
	{ value: "group:local", label: "local stack", hint: "Whisper ASR, local LLM, local TTS" },
	{ value: "group:elevenlabs", label: "ElevenLabs TTS", hint: "external TTS provider, voice, model" },
	{ value: "group:session", label: "memory & session", hint: "voice memory and Eve continuity" },
];
export const VOICE_GROUPS: Record<string, { readonly title: string; readonly options: readonly MenuOption[] }> = {
	"group:realtime": {
		title: "Choose the realtime voice setting to change.",
		options: [
			{ value: "realtime-model", label: "realtime model", hint: "gpt-realtime / grok-voice-2 / local LLM" },
			{ value: "realtime-voice", label: "realtime voice", hint: "native provider voice" },
		],
	},
	"group:local": {
		title: "Choose the local voice stack setting to change.",
		options: [
			{ value: "local-defaults", label: "use local defaults", hint: "Whisper + Ollama + Mac voice" },
			{ value: "asr-model", label: "ASR model", hint: "whisper.cpp ggml model path" },
			{ value: "asr-command", label: "ASR command", hint: "whisper-cli" },
			{ value: "local-base-url", label: "LLM endpoint", hint: DEFAULT_LOCAL_BASE_URL },
			{ value: "local-tts-engine", label: "TTS engine", hint: "say or command" },
			{ value: "local-tts-command", label: "TTS command", hint: "reads text, emits PCM" },
		],
	},
	"group:elevenlabs": {
		title: "Choose the ElevenLabs TTS setting to change.",
		options: [
			{ value: "tts-provider", label: "TTS provider", hint: "realtime or ElevenLabs" },
			{ value: "elevenlabs-voice", label: "voice id" },
			{ value: "elevenlabs-model", label: "TTS model" },
		],
	},
	"group:session": {
		title: "Choose the memory & session setting to change.",
		options: [
			{ value: "memory-limit", label: "voice memory context", hint: "0-50 facts" },
			{ value: "eve-session", label: "Eve voice session", hint: "voice continuity turn" },
		],
	},
};
export const VOICE_REALTIME_PROVIDER_OPTIONS: readonly MenuOption[] = [
	{ value: "openai", label: "provider: OpenAI", hint: "OpenAI realtime API" },
	{ value: "xai", label: "provider: xAI", hint: "Grok realtime API" },
	{ value: "local", label: "local voice", hint: "Whisper + local LLM + local TTS" },
];
export const VOICE_TTS_PROVIDER_OPTIONS: readonly MenuOption[] = [
	{ value: "realtime", label: "realtime", hint: "provider-native audio" },
	{ value: "elevenlabs", label: "elevenlabs", hint: "external ElevenLabs TTS" },
];
export const VOICE_LOCAL_TTS_ENGINE_OPTIONS: readonly MenuOption[] = [
	{ value: "say", label: "say", hint: "macOS built-in voice" },
	{ value: "command", label: "command", hint: "custom command emits raw PCM" },
];
export const VOICE_EVE_SESSION_OPTIONS: readonly MenuOption[] = [
	{ value: "on", label: "on", hint: "default" },
	{ value: "off", label: "off" },
];
// Top-level auth menu groups eleven flat credentials into four categories so the
// list stays short; each group drills into the matching credential pickers.
export const AUTH_GROUP_OPTIONS: readonly MenuOption[] = [
	{ value: "group:subscriptions", label: "subscriptions", hint: "Codex and Claude OAuth logins" },
	{ value: "group:keys", label: "API keys", hint: "xAI, Gemini, OpenAI, ElevenLabs, local voice" },
	{ value: "group:tokens", label: "tokens", hint: "Discord credential and relay token" },
	{ value: "mcp", label: "MCP connection auth", hint: "Linear, Figma, and curated connections" },
];
export const AUTH_SUBSCRIPTION_OPTIONS: readonly MenuOption[] = [
	{ value: "codex", label: "Codex login", hint: "ChatGPT subscription OAuth" },
	{ value: "claude", label: "Claude login", hint: "Claude subscription OAuth" },
];
export const AUTH_KEY_OPTIONS: readonly MenuOption[] = [
	{ value: "xai", label: "xAI API key", hint: "CLANKY_XAI_API_KEY" },
	{ value: "gemini", label: "Gemini API key", hint: "CLANKY_GEMINI_API_KEY" },
	{ value: "openai", label: "OpenAI API key", hint: "CLANKY_OPENAI_API_KEY" },
	{ value: "elevenlabs", label: "ElevenLabs API key", hint: "CLANKY_ELEVENLABS_API_KEY" },
	{ value: "local-voice", label: "local voice API key", hint: "CLANKY_VOICE_LOCAL_API_KEY" },
];
export const AUTH_TOKEN_OPTIONS: readonly MenuOption[] = [
	{ value: "discord", label: "Discord credential", hint: "bot/user token and voice flag" },
	{ value: "relay", label: "relay token", hint: "CLANKY_RELAY_TOKEN" },
];
export const AUTH_SECRET_TARGETS: Record<
	AuthSecretAction,
	{
		readonly envKey: string;
		readonly label: string;
		readonly placeholder: string;
		readonly savedMessage: string;
	}
> = {
	openai: {
		envKey: "CLANKY_OPENAI_API_KEY",
		label: "OpenAI API key",
		placeholder: "OpenAI API key",
		savedMessage: "OpenAI API key saved",
	},
	elevenlabs: {
		envKey: "CLANKY_ELEVENLABS_API_KEY",
		label: "ElevenLabs API key",
		placeholder: "ElevenLabs API key",
		savedMessage: "ElevenLabs API key saved",
	},
	relay: {
		envKey: "CLANKY_RELAY_TOKEN",
		label: "relay token",
		placeholder: "relay bearer token",
		savedMessage: "Relay token saved",
	},
	"local-voice": {
		envKey: "CLANKY_VOICE_LOCAL_API_KEY",
		label: "local voice API key",
		placeholder: "local voice API key",
		savedMessage: "Local voice API key saved",
	},
};
export const DISCORD_CREDENTIAL_KIND_OPTIONS: readonly MenuOption[] = [
	{ value: "bot-token", label: "bot token", hint: "recommended" },
	{ value: "user-token", label: "user token", hint: "only when explicitly needed" },
];
export const DISCORD_TOKEN_VOICE_OPTIONS: readonly MenuOption[] = [
	{ value: "off", label: "chat only" },
	{ value: "on", label: "chat + voice", hint: "enable Discord voice runtime" },
];
export const DISCORD_TOKEN_ACTION_OPTIONS: readonly MenuOption[] = [
	{ value: "status", label: "status", hint: "show credential + voice state" },
	{ value: "set", label: "set credential", hint: "paste token and restart Clanky" },
];
export const APPROVAL_OPTIONS: readonly MenuOption[] = [
	{ value: "auto", label: "auto approve", hint: "run tool calls without prompts" },
	{ value: "prompt", label: "prompt", hint: "restore per-tool approvals" },
];
export const AGENT_MD_OPTIONS: readonly MenuOption[] = [
	{ value: "on", label: "on", hint: "load AGENTS.md/agent.md files into instructions" },
	{ value: "off", label: "off", hint: "ignore filesystem agent instruction files" },
	{ value: "root", label: "root", hint: "set the scan start directory" },
	{ value: "clear-root", label: "clear root", hint: "use the brain working directory" },
];
export const TRACE_OPTIONS: readonly MenuOption[] = [
	{ value: "off", label: "off" },
	{ value: "no-reply", label: "no-reply", hint: "show compact no-reply traces" },
	{ value: "all", label: "all", hint: "show compact trace after every turn" },
];
export const LAYOUT_OPTIONS: readonly MenuOption[] = [
	{ value: "input", label: "input placement", hint: "top or bottom" },
	{ value: "status", label: "status placement", hint: "above or below input" },
	{ value: "spinner", label: "thinking spinner", hint: "expo-agent-spinners frames" },
	{ value: "spinner-rate", label: "spinner rate", hint: "ms per spinner style" },
	{ value: "header", label: "header", hint: "show or hide the sticky header" },
];
export const LAYOUT_INPUT_OPTIONS: readonly MenuOption[] = [
	{ value: "bottom", label: "bottom", hint: "default" },
	{ value: "top", label: "top", hint: "pin chat input above the transcript" },
];
export const LAYOUT_STATUS_OPTIONS: readonly MenuOption[] = [
	{ value: "above-input", label: "above input", hint: "default" },
	{ value: "below-input", label: "below input" },
];
export const LAYOUT_HEADER_OPTIONS: readonly MenuOption[] = [
	{ value: "on", label: "on" },
	{ value: "off", label: "off" },
];
export const PET_OPTIONS: readonly MenuOption[] = [
	{ value: "on", label: "on" },
	{ value: "off", label: "off" },
];
export const BROWSER_BRIDGE_OPTIONS: readonly MenuOption[] = [
	{ value: "status", label: "view bridge status" },
	{ value: "install", label: "install bridge", hint: "write extension and daemon config" },
];
export const DEFAULT_OPENAI_IMAGE_MODEL = "gpt-image-2";
export const ENTER_IMAGE_MODEL_OPTION = "__enter_image_model__";
// Top-level scope menu groups the six server/channel verbs into two submenus
// so the list stays short; each group drills into set/add/remove.
export const DISCORD_SCOPE_GROUP_OPTIONS: readonly MenuOption[] = [
	{ value: "group:guilds", label: "servers", hint: "set, add, or remove server ids" },
	{ value: "group:channels", label: "channels", hint: "set, add, or remove channel/thread ids" },
	{ value: "dms", label: "DMs", hint: "allow or block private replies" },
	{ value: "clear", label: "clear scope", hint: "remove allowlist settings" },
];
export const DISCORD_SCOPE_TARGET_ACTION_OPTIONS: readonly MenuOption[] = [
	{ value: "set", label: "set (replace)", hint: "replace the allowlist" },
	{ value: "add", label: "add", hint: "append ids" },
	{ value: "remove", label: "remove", hint: "choose existing ids to remove" },
];
export const DISCORD_SCOPE_CLEAR_OPTIONS: readonly MenuOption[] = [
	{ value: "all", label: "all", hint: "servers, channels, and DM override" },
	{ value: "guilds", label: "servers", hint: "server allowlist only" },
	{ value: "channels", label: "channels", hint: "channel/thread allowlist only" },
	{ value: "dms", label: "DM override", hint: "return DMs to default allowed" },
];
export const DISCORD_SCOPE_TARGET_OPTIONS: readonly MenuOption[] = [
	{ value: "guilds", label: "servers", hint: "Discord guild/server ids" },
	{ value: "channels", label: "channels", hint: "channel, thread, or parent-channel ids" },
];
export const DISCORD_DM_OPTIONS: readonly MenuOption[] = [
	{ value: "on", label: "allow DMs" },
	{ value: "off", label: "block DMs" },
];
export const CODING_HARNESS_OPTIONS: readonly MenuOption[] = [
	{ value: "clanky", label: "clanky", hint: BUILTIN_CODING_HARNESSES.clanky.description },
	{ value: "claude", label: "claude", hint: BUILTIN_CODING_HARNESSES.claude.description },
	{ value: "codex", label: "codex", hint: BUILTIN_CODING_HARNESSES.codex.description },
	{ value: "opencode", label: "opencode", hint: BUILTIN_CODING_HARNESSES.opencode.description },
	{ value: "custom", label: "custom", hint: "user-supplied command run in a Herdr pane" },
];
export const CODING_RUNTIME_OPTIONS: readonly MenuOption[] = [
	{ value: "clanky", label: "clanky", hint: "allow Clanky's coding skills" },
	{ value: "native", label: "native", hint: "use the harness internals" },
	{ value: "opencode", label: "opencode", hint: "OpenCode-native alias" },
];
export const CODING_HARNESS_ACTION_OPTIONS: readonly MenuOption[] = [
	{ value: "allow", label: "allowed harnesses", hint: "toggle workers Clanky may use" },
	{ value: "transcripts", label: "worker transcripts", hint: "capture durable worker output" },
	{ value: "launchers", label: "launcher settings", hint: "choose default-vs-Ollama models" },
	{ value: "custom", label: "custom command", hint: "set command + runtime for custom worker" },
];
export const WORKER_TRANSCRIPT_OPTIONS: readonly MenuOption[] = [
	{ value: "on", label: "on", hint: "default" },
	{ value: "off", label: "off" },
];
export const CODING_HARNESS_LAUNCHER_OPTIONS: readonly MenuOption[] = [
	{ value: "default", label: "default", hint: "use the CLI's configured model" },
	{ value: "ollama", label: "ollama", hint: "launch through ollama with a model id" },
];
export const MCP_TRANSPORT_OPTIONS: readonly MenuOption[] = [
	{ value: "stdio", label: "stdio", hint: "local command" },
	{ value: "streamable-http", label: "streamable-http", hint: "HTTP MCP endpoint" },
	{ value: "sse", label: "sse", hint: "SSE MCP endpoint" },
];
export const PUSH_ACTION_OPTIONS: readonly MenuOption[] = [
	{ value: "key-path", label: "APNs key path", hint: "AuthKey_XXXX.p8 file path" },
	{ value: "key-id", label: "APNs key ID", hint: "10-character Apple key id" },
	{ value: "team-id", label: "Apple team ID", hint: "10-character developer team id" },
	{ value: "bundle-id", label: "bundle id", hint: `default ${DEFAULT_APNS_BUNDLE_ID}` },
	{ value: "env", label: "APNs environment", hint: "sandbox/development or production" },
	{ value: "test", label: "send test notification", hint: "push to registered devices" },
	{ value: "clear", label: "clear APNs config", hint: "remove saved APNs env vars" },
];
export const PUSH_APNS_ENV_OPTIONS: readonly MenuOption[] = [
	{ value: "sandbox", label: "sandbox", hint: "Debug/development APNs" },
	{ value: "production", label: "production", hint: "Release/TestFlight/App Store APNs" },
];
export const SETTINGS_STATUS_TOGGLE_VALUE = "__settings_status_toggle__";
export const SETTINGS_STATUS_EXPAND_ICON = "▲";
export const SETTINGS_STATUS_COLLAPSE_ICON = "▶";
export const MCP_DYNAMIC_NAME_RE = /^[a-z0-9][a-z0-9_-]*$/i;
export const MCP_CONNECTION_INFO_UNAVAILABLE = "(curated connection inventory unavailable: /eve/v1/info is not healthy)";

export type ClankyConfig = {
	provider: "codex" | "claude" | "local" | "xai" | "gemini";
	codexModel?: string;
	claudeModel?: string;
	codexEffort?: string;
	localModel?: string;
	localBaseUrl?: string;
	localEffort?: string;
	localContextTokens?: string;
	xaiModel?: string;
	geminiModel?: string;
	xaiApiKeyPresent?: boolean;
	geminiApiKeyPresent?: boolean;
	openAiApiKeyPresent?: boolean;
	elevenLabsApiKeyPresent?: boolean;
	relayTokenPresent?: boolean;
	voiceLocalApiKeyPresent?: boolean;
	visionModel?: string;
	visionEnabled?: string;
	visionProvider?: string;
	openAiVisionModel?: string;
	autoApprove?: string;
	agentMd?: string;
	agentMdRoot?: string;
	pet?: string;
	codingHarness?: string;
	codingHarnesses?: string;
	codingHarnessCommand?: string;
	codingHarnessRuntime?: string;
	workerTranscripts?: string;
	codingHarnessClaudeLauncher?: string;
	codingHarnessClaudeModel?: string;
	codingHarnessCodexLauncher?: string;
	codingHarnessCodexModel?: string;
	codingHarnessOpencodeLauncher?: string;
	codingHarnessOpencodeModel?: string;
	imageModel?: string;
	xaiImageModel?: string;
	geminiImageModel?: string;
	imageProvider?: string;
	videoProvider?: string;
	xaiVideoModel?: string;
	voiceRealtimeProvider?: string;
	voiceRealtimeModel?: string;
	voiceRealtimeVoice?: string;
	voiceTtsProvider?: string;
	voiceAsrModel?: string;
	voiceAsrCommand?: string;
	voiceLocalBaseUrl?: string;
	voiceLocalTtsEngine?: string;
	voiceLocalTtsCommand?: string;
	elevenLabsVoiceId?: string;
	elevenLabsTtsModel?: string;
	voiceMemoryContextLimit?: string;
	voiceEveSession?: string;
	discordCredentialKind?: string;
	discordVoice?: string;
	discordTokenPresent?: boolean;
	discordAllowedGuildIds?: string;
	discordAllowedChannelIds?: string;
	discordAllowDms?: string;
	apnsKeyPath?: string;
	apnsKeyId?: string;
	apnsTeamId?: string;
	apnsBundleId?: string;
	apnsEnvironment?: string;
};
