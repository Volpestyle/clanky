/**
 * CLANKY_* environment variable reference generator.
 *
 * Scans the source (agent/, bin/, scripts/, packages/) for CLANKY_* env reads
 * and emits docs/env-reference.md from the description table below, so the doc
 * can never silently drift from the code:
 *   - a var read in code but missing from the table fails the run (add it),
 *   - a table entry no longer read anywhere fails the run (delete it),
 *   - `--check` additionally fails when docs/env-reference.md is stale.
 *
 * Usage:
 *   pnpm env:reference           regenerate docs/env-reference.md
 *   pnpm env:reference --check   verify the doc matches the code (CI-friendly)
 */
import type { Dirent } from "node:fs";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCAN_ROOTS = ["agent", "bin", "scripts", "packages"];
const OUTPUT_PATH = join(REPO, "docs", "env-reference.md");

// Names that appear in source text but are not env vars (doc prose examples).
const NOT_ENV_VARS = new Set(["CLANKY_X"]);

// Dynamic env-name families built at runtime (template strings the scanner
// cannot see whole). Keep in sync with agent/lib/coding-harness.ts.
const DYNAMIC_FAMILY_NAMES = [
	"CLANKY_CODING_HARNESS_CLAUDE_LAUNCHER",
	"CLANKY_CODING_HARNESS_CLAUDE_MODEL",
	"CLANKY_CODING_HARNESS_CODEX_LAUNCHER",
	"CLANKY_CODING_HARNESS_CODEX_MODEL",
	"CLANKY_CODING_HARNESS_OPENCODE_LAUNCHER",
	"CLANKY_CODING_HARNESS_OPENCODE_MODEL",
];

type EnvVarDoc = { readonly group: string; readonly desc: string };

const GROUP_ORDER = [
	"Core paths & lifecycle",
	"Eve server address & supervision",
	"Brain model selection",
	"API keys & credential stores",
	"Relay & iOS",
	"Push notifications (APNs / FCM)",
	"Discord presence (text)",
	"Discord voice & ClankVox",
	"Voice runtime",
	"Media (image / video / vision)",
	"Workers & coding harnesses",
	"Face / TUI",
	"Memory, instructions & approvals",
	"Integrations & MCP",
	"Dev & test",
];

const DOCS: Record<string, EnvVarDoc> = {
	// --- Core paths & lifecycle -------------------------------------------
	CLANKY_HOME: { group: "Core paths & lifecycle", desc: "Clanky data root for durable state (default `~/.clanky`): auth store, transcripts, memory, push registry, media." },
	CLANKY_REPO_DIR: { group: "Core paths & lifecycle", desc: "Repo checkout dir; anchors `.env.local`, the spawn seam's `bin/clanky.ts`, and mirror scripts when a process is not started from the repo root." },
	CLANKY_SESSION: { group: "Core paths & lifecycle", desc: "Herdr session name the lifecycle script targets (default `clankies`)." },
	CLANKY_BRAIN_AGENT: { group: "Core paths & lifecycle", desc: "Herdr agent name for the command-host/brain pane (default `clanky`)." },
	CLANKY_HERDR_BIN: { group: "Core paths & lifecycle", desc: "herdr binary the lifecycle script uses (default `herdr` on PATH)." },
	CLANKY_MAIN_AGENT: { group: "Core paths & lifecycle", desc: "Herdr agent name of the main face pane, for gateway bridge commands (default `clanky`)." },
	CLANKY_UP_SESSION_TIMEOUT_MS: { group: "Core paths & lifecycle", desc: "How long `clanky up` waits for the herdr session to start (default 15000)." },

	// --- Eve server address & supervision ---------------------------------
	CLANKY_EVE_PORT: { group: "Eve server address & supervision", desc: "eve/relay port (default 2000)." },
	CLANKY_EVE_BIND_HOST: { group: "Eve server address & supervision", desc: "Interface the owned eve dev server binds to (e.g. `127.0.0.1`, `0.0.0.0`); never a URL. See agent/lib/eve-address.ts." },
	CLANKY_EVE_BASE_URL: { group: "Eve server address & supervision", desc: "Base URL other processes use to reach the eve server (default `http://127.0.0.1:<port>`); always a URL." },
	CLANKY_EVE_HOST: { group: "Eve server address & supervision", desc: "Legacy combined var: an http(s) URL is treated as CLANKY_EVE_BASE_URL, a bare host as CLANKY_EVE_BIND_HOST. Prefer the split vars." },
	CLANKY_EVE_HEALTH_TIMEOUT_MS: { group: "Eve server address & supervision", desc: "How long the face/CLI/lifecycle wait for a starting brain to become healthy (default 180000)." },
	CLANKY_EVE_HEALTH_POLL_MS: { group: "Eve server address & supervision", desc: "Face brain-health poll interval (default 5000)." },
	CLANKY_EVE_STOP_TIMEOUT_MS: { group: "Eve server address & supervision", desc: "SIGTERM grace before SIGKILL when stopping the owned eve server (default 5000)." },
	CLANKY_EVE_KILL_TIMEOUT_MS: { group: "Eve server address & supervision", desc: "Wait after SIGKILL when stopping the owned eve server (default 2000)." },
	CLANKY_EVE_PROBE_TIMEOUT_MS: { group: "Eve server address & supervision", desc: "Per-probe fetch timeout for /eve/v1/info health checks (default 2000)." },
	CLANKY_EVE_RESTART_STOP_TIMEOUT_MS: { group: "Eve server address & supervision", desc: "Shorter SIGTERM grace used for intentional config-change restarts (default 1000)." },
	CLANKY_EVE_CALLBACK_PROXY: { group: "Eve server address & supervision", desc: "Set `0` to disable the localhost OAuth callback proxy the face runs for connection auth flows." },
	CLANKY_EVE_CALLBACK_PROXY_PORT: { group: "Eve server address & supervision", desc: "Port for the OAuth callback proxy (default 3000)." },
	CLANKY_RESTART_ATTACHED_EVE: { group: "Eve server address & supervision", desc: "Set `1` to let the face restart an attached (non-owned) eve dev server after config writes, even when it is not an ancestor process." },

	// --- Brain model selection --------------------------------------------
	CLANKY_MODEL_PROVIDER: { group: "Brain model selection", desc: "Conductor brain route: `codex` (default), `claude`, `local`, `xai`, or `gemini`." },
	CLANKY_CODEX_MODEL: { group: "Brain model selection", desc: "Codex brain model id (default from agent/lib/config-defaults.ts)." },
	CLANKY_CODEX_EFFORT: { group: "Brain model selection", desc: "Codex reasoning effort: minimal|low|medium|high|xhigh." },
	CLANKY_CLAUDE_MODEL: { group: "Brain model selection", desc: "Claude brain model id (default from config-defaults.ts)." },
	CLANKY_LOCAL_MODEL: { group: "Brain model selection", desc: "Local brain model id served by the OpenAI-compatible endpoint." },
	CLANKY_LOCAL_BASE_URL: { group: "Brain model selection", desc: "Local OpenAI-compatible endpoint (default `http://127.0.0.1:11434/v1`)." },
	CLANKY_LOCAL_EFFORT: { group: "Brain model selection", desc: "reasoning_effort forwarded to thinking local models: low|medium|high." },
	CLANKY_LOCAL_CONTEXT_TOKENS: { group: "Brain model selection", desc: "Context window for the local brain (eve cannot resolve off-catalog models); the face auto-injects it from Ollama metadata." },
	CLANKY_LOCAL_PROVIDER_NAME: { group: "Brain model selection", desc: "Provider name label for the local model endpoint (obscure)." },
	CLANKY_LOCAL_MODEL_SUPPORTS_VISION: { group: "Brain model selection", desc: "Set `1` when the local brain accepts image input, so media_inspect can use it directly." },
	CLANKY_XAI_MODEL: { group: "Brain model selection", desc: "xAI brain model id (default from config-defaults.ts)." },
	CLANKY_XAI_CONTEXT_TOKENS: { group: "Brain model selection", desc: "Context window override for the xAI brain (off-catalog)." },
	CLANKY_GEMINI_MODEL: { group: "Brain model selection", desc: "Gemini brain model id (default from config-defaults.ts)." },
	CLANKY_GEMINI_CONTEXT_TOKENS: { group: "Brain model selection", desc: "Context window override for the Gemini brain (off-catalog)." },
	CLANKY_STARTUP_MODEL_FALLBACK_PROVIDER: { group: "Brain model selection", desc: "Internal: set by the launcher when a keyless xai/gemini selection fell back to Codex at startup, so the face can show the notice." },
	CLANKY_STARTUP_MODEL_FALLBACK_ENV_NAMES: { group: "Brain model selection", desc: "Internal: the missing API-key env names for the startup-fallback notice." },

	// --- API keys & credential stores -------------------------------------
	CLANKY_XAI_API_KEY: { group: "API keys & credential stores", desc: "xAI API key (fallback: XAI_API_KEY). Brain, Grok media, and realtime voice." },
	CLANKY_GEMINI_API_KEY: { group: "API keys & credential stores", desc: "Gemini API key (fallbacks: GEMINI_API_KEY, GOOGLE_GENERATIVE_AI_API_KEY)." },
	CLANKY_OPENAI_API_KEY: { group: "API keys & credential stores", desc: "OpenAI API key (fallback: OPENAI_API_KEY). Images, vision fallback, realtime voice." },
	CLANKY_ELEVENLABS_API_KEY: { group: "API keys & credential stores", desc: "ElevenLabs API key (fallback: ELEVENLABS_API_KEY) for external TTS." },
	CLANKY_CLAUDE_AUTH: { group: "API keys & credential stores", desc: "Override path to the Claude subscription OAuth store (default `<CLANKY_HOME>/profiles/default/auth.json`)." },
	CLANKY_CODEX_AUTH: { group: "API keys & credential stores", desc: "Override path to the Codex subscription OAuth store (default `<CLANKY_HOME>/profiles/default/auth.json`)." },
	CLANKY_OPENAI_BASE_URL: { group: "API keys & credential stores", desc: "OpenAI-compatible base URL override for keyed OpenAI calls (obscure)." },
	CLANKY_XAI_BASE_URL: { group: "API keys & credential stores", desc: "xAI base URL override (obscure)." },

	// --- Relay & iOS --------------------------------------------------------
	CLANKY_RELAY_TOKEN: { group: "Relay & iOS", desc: "Bearer token for the relay WS channel; the relay is fail-closed without it. Encoded into the `clanky pair` QR." },
	CLANKY_LOCAL_USER_ID: { group: "Relay & iOS", desc: "Principal id minted for socket-verified loopback requests (default $USER; frontdoor-auth)." },
	CLANKY_RELAY_TRACE: { group: "Relay & iOS", desc: "Set `1` to write relay latency trace logs (write/keys t0 echo)." },
	CLANKY_IOS_WORKSPACE_ID: { group: "Relay & iOS", desc: "Herdr workspace id override for the dedicated iOS chat-mirror workspace (ADR-0004)." },
	CLANKY_IOS_WORKSPACE_LABEL: { group: "Relay & iOS", desc: "Label for the iOS chat-mirror workspace (default `Clanky`)." },

	// --- Push notifications -------------------------------------------------
	CLANKY_APNS_KEY_PATH: { group: "Push notifications (APNs / FCM)", desc: "Path to the Apple APNs AuthKey_XXXX.p8 file (token-based auth)." },
	CLANKY_APNS_KEY: { group: "Push notifications (APNs / FCM)", desc: "Legacy alias for CLANKY_APNS_KEY_PATH." },
	CLANKY_APNS_KEY_ID: { group: "Push notifications (APNs / FCM)", desc: "Apple APNs key id (10 chars)." },
	CLANKY_APNS_TEAM_ID: { group: "Push notifications (APNs / FCM)", desc: "Apple developer team id (10 chars)." },
	CLANKY_APNS_BUNDLE_ID: { group: "Push notifications (APNs / FCM)", desc: "APNs topic / iOS bundle id (default `io.clanky.ios`)." },
	CLANKY_APNS_ENV: { group: "Push notifications (APNs / FCM)", desc: "APNs environment: `sandbox` (default) or `production`." },
	CLANKY_FCM_SERVICE_ACCOUNT_PATH: { group: "Push notifications (APNs / FCM)", desc: "Path to the FCM service-account JSON (fallback: GOOGLE_APPLICATION_CREDENTIALS)." },
	CLANKY_FCM_PROJECT_ID: { group: "Push notifications (APNs / FCM)", desc: "FCM project id (with the env-only credential trio, or overriding the service-account file)." },
	CLANKY_FCM_CLIENT_EMAIL: { group: "Push notifications (APNs / FCM)", desc: "FCM service-account client email (env-only trio)." },
	CLANKY_FCM_PRIVATE_KEY: { group: "Push notifications (APNs / FCM)", desc: "FCM service-account private key (env-only trio)." },
	CLANKY_FCM_TOKEN_URI: { group: "Push notifications (APNs / FCM)", desc: "OAuth token URI override for FCM (obscure)." },

	// --- Discord presence (text) -------------------------------------------
	CLANKY_DISCORD_PRESENCE: { group: "Discord presence (text)", desc: "Set `1` to start the always-on Discord gateway presence (set by the runtime, not build)." },
	CLANKY_DISCORD_TOKEN: { group: "Discord presence (text)", desc: "Discord credential (fallback: DISCORD_BOT_TOKEN); bot or user/self token per CLANKY_DISCORD_CREDENTIAL_KIND." },
	CLANKY_DISCORD_CREDENTIAL_KIND: { group: "Discord presence (text)", desc: "`bot-token` (default) or `user-token` (private calls + Go Live; ToS-gray, opt-in)." },
	CLANKY_DISCORD_ALLOWED_GUILD_IDS: { group: "Discord presence (text)", desc: "Comma/space server allowlist; empty = any." },
	CLANKY_DISCORD_ALLOWED_CHANNEL_IDS: { group: "Discord presence (text)", desc: "Comma/space channel/thread allowlist; empty = any." },
	CLANKY_DISCORD_ALLOW_DMS: { group: "Discord presence (text)", desc: "Set `0` to block DM replies (allowed by default)." },
	CLANKY_DISCORD_WAKE_NAMES: { group: "Discord presence (text)", desc: "Extra wake-name aliases for chat addressing (comma/space list)." },
	CLANKY_DISCORD_ENGAGEMENT_WINDOW_MINUTES: { group: "Discord presence (text)", desc: "Minutes an active exchange keeps accepting follow-ups without re-tagging." },

	// --- Discord voice & ClankVox --------------------------------------------
	CLANKY_DISCORD_VOICE: { group: "Discord voice & ClankVox", desc: "Set `1` to enable the Discord voice runtime and voice intents." },
	CLANKY_DISCORD_VOICE_WAKE_NAMES: { group: "Discord voice & ClankVox", desc: "Wake-name aliases for voice barge-in (defaults to chat wake names)." },
	CLANKY_DISCORD_VOICE_CATCH_UP_WINDOW_MS: { group: "Discord voice & ClankVox", desc: "Startup replay window for recent voice intents after a restart." },
	CLANKY_DISCORD_VOICE_FAIL_ON_REALTIME_ERROR: { group: "Discord voice & ClankVox", desc: "Smoke/test gate: fail instead of degrading on realtime errors (obscure)." },
	CLANKY_DISCORD_VOICE_REQUIRE_ALL: { group: "Discord voice & ClankVox", desc: "Live-voice acceptance gate: require all checks (test harness, obscure)." },
	CLANKY_DISCORD_VOICE_REQUIRE_ASK_PI: { group: "Discord voice & ClankVox", desc: "Live-voice acceptance gate (test harness, obscure)." },
	CLANKY_DISCORD_VOICE_REQUIRE_GROUP_AUDIO: { group: "Discord voice & ClankVox", desc: "Live-voice acceptance gate (test harness, obscure)." },
	CLANKY_DISCORD_VOICE_REQUIRE_INPUT_AUDIO: { group: "Discord voice & ClankVox", desc: "Live-voice acceptance gate (test harness, obscure)." },
	CLANKY_DISCORD_VOICE_REQUIRE_OUTPUT_AUDIO: { group: "Discord voice & ClankVox", desc: "Live-voice acceptance gate (test harness, obscure)." },
	CLANKY_DISCORD_VOICE_REQUIRE_REALTIME_SESSION: { group: "Discord voice & ClankVox", desc: "Live-voice acceptance gate (test harness, obscure)." },
	CLANKY_DISCORD_VOICE_REQUIRE_SCREEN_FRAME: { group: "Discord voice & ClankVox", desc: "Live-voice acceptance gate (test harness, obscure)." },
	CLANKY_DISCORD_VOICE_REQUIRE_STREAM_WATCH: { group: "Discord voice & ClankVox", desc: "Live-voice acceptance gate (test harness, obscure)." },
	CLANKY_DISCORD_VOICE_REQUIRE_TOOL_CALL: { group: "Discord voice & ClankVox", desc: "Live-voice acceptance gate (test harness, obscure)." },
	CLANKY_CLANKVOX_DIR: { group: "Discord voice & ClankVox", desc: "ClankVox source checkout override (default sibling `../clankvox`)." },
	CLANKY_CLANKVOX_BIN: { group: "Discord voice & ClankVox", desc: "Prebuilt ClankVox binary override; skips source resolution." },

	// --- Voice runtime --------------------------------------------------------
	CLANKY_VOICE_REALTIME_PROVIDER: { group: "Voice runtime", desc: "Realtime voice provider: `openai` (default), `xai`, or `local`." },
	CLANKY_VOICE_REALTIME_MODEL: { group: "Voice runtime", desc: "Realtime model id (gpt-realtime / grok-voice-2 / local LLM)." },
	CLANKY_VOICE_REALTIME_VOICE: { group: "Voice runtime", desc: "Provider-native voice name (default `marin`; local default `Samantha`)." },
	CLANKY_VOICE_TTS_PROVIDER: { group: "Voice runtime", desc: "Outbound TTS: `realtime` (provider-native audio) or `elevenlabs`." },
	CLANKY_VOICE_ASR_MODEL: { group: "Voice runtime", desc: "whisper.cpp ggml model path for the local voice stack." },
	CLANKY_VOICE_ASR_COMMAND: { group: "Voice runtime", desc: "ASR command for the local stack (default whisper-cli)." },
	CLANKY_VOICE_ASR_LANGUAGE: { group: "Voice runtime", desc: "ASR language hint for the local stack (obscure)." },
	CLANKY_VOICE_LOCAL_BASE_URL: { group: "Voice runtime", desc: "Local voice LLM endpoint (separate from the conductor's, so voice stays low-latency)." },
	CLANKY_VOICE_LOCAL_API_KEY: { group: "Voice runtime", desc: "API key for the local voice LLM endpoint, when it requires one." },
	CLANKY_VOICE_LOCAL_TTS_ENGINE: { group: "Voice runtime", desc: "Local TTS engine: `say` (macOS) or `command`." },
	CLANKY_VOICE_LOCAL_TTS_COMMAND: { group: "Voice runtime", desc: "Custom local TTS command (reads text, emits PCM)." },
	CLANKY_VOICE_MEMORY_CONTEXT_LIMIT: { group: "Voice runtime", desc: "Memory facts injected into voice turns, 0-50 (falls back to CLANKY_MEMORY_CONTEXT_LIMIT)." },
	CLANKY_VOICE_EVE_SESSION: { group: "Voice runtime", desc: "Set `0` to disable the durability eve session behind voice (on by default)." },
	CLANKY_VOICE_INSTRUCTIONS: { group: "Voice runtime", desc: "Override the realtime voice persona instructions." },
	CLANKY_VOICE_AUDIO_SAMPLE_RATE: { group: "Voice runtime", desc: "Inbound audio sample rate override (obscure)." },
	CLANKY_VOICE_TTS_SAMPLE_RATE: { group: "Voice runtime", desc: "Outbound TTS sample rate override (obscure)." },
	CLANKY_ELEVENLABS_VOICE_ID: { group: "Voice runtime", desc: "ElevenLabs voice id; presence also infers the TTS provider." },
	CLANKY_ELEVENLABS_TTS_MODEL: { group: "Voice runtime", desc: "ElevenLabs TTS model id." },
	CLANKY_ELEVENLABS_BASE_URL: { group: "Voice runtime", desc: "ElevenLabs API base URL override (obscure)." },
	CLANKY_ELEVENLABS_OUTPUT_FORMAT: { group: "Voice runtime", desc: "ElevenLabs PCM output format override (obscure)." },
	CLANKY_ELEVENLABS_SPEED: { group: "Voice runtime", desc: "ElevenLabs speech speed override (obscure)." },

	// --- Media -----------------------------------------------------------------
	CLANKY_IMAGE_PROVIDER: { group: "Media (image / video / vision)", desc: "Default image-generation provider: openai|xai|gemini." },
	CLANKY_OPENAI_IMAGE_MODEL: { group: "Media (image / video / vision)", desc: "OpenAI image model (default gpt-image-2)." },
	CLANKY_XAI_IMAGE_MODEL: { group: "Media (image / video / vision)", desc: "Grok Imagine image model." },
	CLANKY_GEMINI_IMAGE_MODEL: { group: "Media (image / video / vision)", desc: "Gemini image model." },
	CLANKY_VIDEO_PROVIDER: { group: "Media (image / video / vision)", desc: "Video-generation provider (currently xai)." },
	CLANKY_XAI_VIDEO_MODEL: { group: "Media (image / video / vision)", desc: "Grok Imagine video model." },
	CLANKY_VISION_ENABLED: { group: "Media (image / video / vision)", desc: "Set `1` to route media_inspect to a dedicated vision model instead of the brain." },
	CLANKY_VISION_MODEL: { group: "Media (image / video / vision)", desc: "Dedicated vision model id (any provider, e.g. a local Ollama model)." },
	CLANKY_VISION_PROVIDER: { group: "Media (image / video / vision)", desc: "Provider for the dedicated vision model." },
	CLANKY_VISION_PROVIDER_NAME: { group: "Media (image / video / vision)", desc: "Provider name label for a local vision endpoint (obscure)." },
	CLANKY_VISION_BASE_URL: { group: "Media (image / video / vision)", desc: "Base URL for a local/OpenAI-compatible vision endpoint." },
	CLANKY_OPENAI_VISION_MODEL: { group: "Media (image / video / vision)", desc: "Keyed OpenAI fallback vision model for media_inspect (default from config-defaults.ts)." },

	// --- Workers & coding harnesses ---------------------------------------------
	CLANKY_CODING_HARNESS: { group: "Workers & coding harnesses", desc: "Default coding harness profile id (clanky|claude|codex|opencode|custom)." },
	CLANKY_CODING_HARNESSES: { group: "Workers & coding harnesses", desc: "Allowlist of harnesses Clanky may spawn (`/harness allow` writes it)." },
	CLANKY_CODING_HARNESS_COMMAND: { group: "Workers & coding harnesses", desc: "Command line for the custom harness profile." },
	CLANKY_CODING_HARNESS_RUNTIME: { group: "Workers & coding harnesses", desc: "Runtime instruction mode for the custom harness: clanky|native|opencode." },
	CLANKY_CODING_HARNESS_CLAUDE_LAUNCHER: { group: "Workers & coding harnesses", desc: "claude worker launcher: `default` or `ollama` (family: CLANKY_CODING_HARNESS_<ID>_LAUNCHER)." },
	CLANKY_CODING_HARNESS_CLAUDE_MODEL: { group: "Workers & coding harnesses", desc: "Model id for the claude worker launcher (family: CLANKY_CODING_HARNESS_<ID>_MODEL)." },
	CLANKY_CODING_HARNESS_CODEX_LAUNCHER: { group: "Workers & coding harnesses", desc: "codex worker launcher: `default` or `ollama`." },
	CLANKY_CODING_HARNESS_CODEX_MODEL: { group: "Workers & coding harnesses", desc: "Model id for the codex worker launcher." },
	CLANKY_CODING_HARNESS_OPENCODE_LAUNCHER: { group: "Workers & coding harnesses", desc: "opencode worker launcher: `default` or `ollama`." },
	CLANKY_CODING_HARNESS_OPENCODE_MODEL: { group: "Workers & coding harnesses", desc: "Model id for the opencode worker launcher." },
	CLANKY_WORKER_TRANSCRIPTS: { group: "Workers & coding harnesses", desc: "Worker transcript capture default, on by default (`/harness transcripts on|off` writes it)." },
	CLANKY_PANE_RECORDER: { group: "Workers & coding harnesses", desc: "Set `1` to run the session-wide pane recorder in the brain (the face sets it for the owned brain inside herdr; `0` opts out)." },
	CLANKY_PANE_RECORDER_RECORD_ALL: { group: "Workers & coding harnesses", desc: "Set `1` to byte-record wrapper-covered worker panes too (default: lifecycle-only; the worker transcript owns their bytes)." },
	CLANKY_CODEX_OLLAMA_HOME: { group: "Workers & coding harnesses", desc: "Isolated CODEX_HOME for Ollama-launched codex workers so they cannot clobber the subscription worker's ~/.codex." },

	// --- Face / TUI ----------------------------------------------------------------
	CLANKY_HEADER: { group: "Face / TUI", desc: "Show/hide the sticky header (`/layout header` writes it)." },
	CLANKY_TUI_INPUT_PLACEMENT: { group: "Face / TUI", desc: "Chat input placement: top|bottom." },
	CLANKY_TUI_STATUS_PLACEMENT: { group: "Face / TUI", desc: "Status bar placement: above-input|below-input." },
	CLANKY_TUI_SPINNER: { group: "Face / TUI", desc: "Thinking-spinner selection (expo-agent-spinners name, preset, or custom cycle)." },
	CLANKY_TUI_SPINNER_RATE_MS: { group: "Face / TUI", desc: "Spinner cycle dwell in ms (fast|normal|slow also accepted)." },
	CLANKY_TUI_UNICODE: { group: "Face / TUI", desc: "Force unicode capability detection for the banner (obscure)." },
	CLANKY_TURN_TRACE: { group: "Face / TUI", desc: "Compact turn trace mode: off|no-reply|all (`/trace` writes it)." },
	CLANKY_FACE_HERDR_PANE_ID: { group: "Face / TUI", desc: "Internal: herdr pane id of the face, forwarded to the owned brain for placement." },
	CLANKY_FACE_HERDR_TAB_ID: { group: "Face / TUI", desc: "Internal: herdr tab id of the face, forwarded to the owned brain." },
	CLANKY_FACE_HERDR_WORKSPACE_ID: { group: "Face / TUI", desc: "Internal: herdr workspace id of the face, forwarded to the owned brain." },

	// --- Memory, instructions & approvals ---------------------------------------------
	CLANKY_MEMORY_CONTEXT_LIMIT: { group: "Memory, instructions & approvals", desc: "Memory facts injected per turn (default 16)." },
	CLANKY_AGENT_MD: { group: "Memory, instructions & approvals", desc: "Set `1` to ingest AGENTS.md/agent.md files into instructions (opt-in trusted prompt material)." },
	CLANKY_AGENT_MD_ROOT: { group: "Memory, instructions & approvals", desc: "Scan start directory for agent instruction files (default: brain cwd)." },
	CLANKY_AUTO_APPROVE: { group: "Memory, instructions & approvals", desc: "Set `1` to run tool calls without approval prompts (`/approvals` writes it)." },
	CLANKY_APPROVAL_MODE: { group: "Memory, instructions & approvals", desc: "host_command approval mode: `read-only` (default), `auto`, or `yolo` (ADR-0003)." },
	CLANKY_YOLO: { group: "Memory, instructions & approvals", desc: "Transient yolo arm for host_command; injected by `/approvals yolo`, never saved here." },
	CLANKY_HOST_COMMAND_ROOT: { group: "Memory, instructions & approvals", desc: "Default cwd for host_command runs (default `~/dev`)." },
	CLANKY_SANDBOX: { group: "Memory, instructions & approvals", desc: "Set to `seatbelt` in host_command child processes so scripts can detect the sandbox; never set it yourself." },
	CLANKY_SANDBOX_NETWORK_DISABLED: { group: "Memory, instructions & approvals", desc: "Set to `1` in host_command children when network egress is denied; never set it yourself." },
	CLANKY_PET: { group: "Memory, instructions & approvals", desc: "Enable the Petdex pet integration (on/off)." },
	CLANKY_PET_PORT: { group: "Memory, instructions & approvals", desc: "Petdex runtime port (obscure)." },
	CLANKY_PET_TOKEN_PATH: { group: "Memory, instructions & approvals", desc: "Petdex update-token path (obscure)." },

	// --- Integrations & MCP -----------------------------------------------------------
	CLANKY_WORK_TRACKER: { group: "Integrations & MCP", desc: "Role-binding override: connection name bound to the work_tracker role." },
	CLANKY_DESIGN_TOOL: { group: "Integrations & MCP", desc: "Role-binding override: connection name bound to the design_tool role." },
	CLANKY_MCP_SERVERS: { group: "Integrations & MCP", desc: "JSON of runtime-added no-auth/static-token MCP servers, merged with ~/.clanky/mcp-servers.json." },
	CLANKY_LINEAR_MCP_URL: { group: "Integrations & MCP", desc: "Linear hosted MCP URL override (obscure)." },
	CLANKY_LINEAR_MCP_CLIENT_METADATA_URL: { group: "Integrations & MCP", desc: "Linear MCP OAuth client-metadata URL override (obscure)." },
	CLANKY_FIGMA_MCP_URL: { group: "Integrations & MCP", desc: "Figma hosted MCP URL override (obscure)." },
	CLANKY_FIGMA_MCP_CLIENT_METADATA_URL: { group: "Integrations & MCP", desc: "Figma MCP OAuth client-metadata URL override (obscure)." },
	CLANKY_BROWSER_BRIDGE_PORT: { group: "Integrations & MCP", desc: "Browser-extension bridge daemon port." },

	// --- Dev & test ----------------------------------------------------------------------
	CLANKY_SMOKE_TIMEOUT_MS: { group: "Dev & test", desc: "Per-test timeout for the `pnpm smoke` aggregate (default 120000)." },
};

async function scanEnvNames(): Promise<Set<string>> {
	const names = new Set<string>();
	const envReadRe = /(?:process\.)?env(?:\??\.)(CLANKY_[A-Z0-9_]+)/g;
	const literalRe = /["'`](CLANKY_[A-Z0-9_]+)["'`]/g;
	for (const root of SCAN_ROOTS) {
		await scanDir(join(REPO, root), names, envReadRe, literalRe);
	}
	for (const name of NOT_ENV_VARS) names.delete(name);
	for (const name of DYNAMIC_FAMILY_NAMES) names.add(name);
	return names;
}

async function scanDir(dir: string, names: Set<string>, envReadRe: RegExp, literalRe: RegExp): Promise<void> {
	let entries: Dirent[];
	try {
		entries = await readdir(dir, { withFileTypes: true });
	} catch {
		return;
	}
	for (const entry of entries) {
		if (entry.name === "node_modules") continue;
		const path = join(dir, entry.name);
		if (entry.isDirectory()) {
			await scanDir(path, names, envReadRe, literalRe);
			continue;
		}
		if (!entry.name.endsWith(".ts") && !entry.name.endsWith(".mts")) continue;
		const text = await readFile(path, "utf8");
		for (const match of text.matchAll(envReadRe)) names.add(match[1] ?? "");
		for (const match of text.matchAll(literalRe)) names.add(match[1] ?? "");
	}
	names.delete("");
}

function renderReference(names: ReadonlySet<string>): string {
	const grouped = new Map<string, string[]>();
	for (const name of [...names].sort((left, right) => left.localeCompare(right))) {
		const doc = DOCS[name];
		if (doc === undefined) continue;
		const rows = grouped.get(doc.group) ?? [];
		rows.push(`| \`${name}\` | ${doc.desc} |`);
		grouped.set(doc.group, rows);
	}
	const sections: string[] = [
		"# CLANKY_* environment variable reference",
		"",
		"Generated by `pnpm env:reference` (scripts/generate-env-reference.ts) from",
		"the CLANKY_* reads in agent/, bin/, scripts/, and packages/. Do not edit by",
		"hand — edit the description table in the generator and regenerate.",
		"",
		"Values are read from the process environment first, then `.env.local` at",
		"the repo root (process.env wins; see agent/lib/env-store.ts).",
	];
	for (const group of GROUP_ORDER) {
		const rows = grouped.get(group);
		if (rows === undefined || rows.length === 0) continue;
		sections.push("", `## ${group}`, "", "| Variable | Description |", "| --- | --- |", ...rows);
	}
	sections.push("");
	return sections.join("\n");
}

const names = await scanEnvNames();
const undocumented = [...names].filter((name) => DOCS[name] === undefined).sort();
const stale = Object.keys(DOCS).filter((name) => !names.has(name)).sort();

if (undocumented.length > 0) {
	process.stderr.write(`env-reference: ${undocumented.length} CLANKY_* var(s) read in code but missing from the description table:\n  ${undocumented.join("\n  ")}\nAdd them to scripts/generate-env-reference.ts.\n`);
}
if (stale.length > 0) {
	process.stderr.write(`env-reference: ${stale.length} documented var(s) no longer read anywhere:\n  ${stale.join("\n  ")}\nDelete them from scripts/generate-env-reference.ts.\n`);
}
if (undocumented.length > 0 || stale.length > 0) process.exit(1);

const rendered = renderReference(names);
if (process.argv.includes("--check")) {
	const existing = await readFile(OUTPUT_PATH, "utf8").catch(() => "");
	if (existing !== rendered) {
		process.stderr.write("env-reference: docs/env-reference.md is stale; run `pnpm env:reference`.\n");
		process.exit(1);
	}
	process.stdout.write(`env-reference: docs/env-reference.md is current (${names.size} vars).\n`);
	process.exit(0);
}
await writeFile(OUTPUT_PATH, rendered, "utf8");
process.stdout.write(`wrote ${OUTPUT_PATH} (${names.size} vars)\n`);
