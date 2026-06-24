import { homedir } from "node:os";
import { join } from "node:path";

export const CLANKY_CODING_HARNESS_ENV = {
	id: "CLANKY_CODING_HARNESS",
	allowed: "CLANKY_CODING_HARNESSES",
	command: "CLANKY_CODING_HARNESS_COMMAND",
	runtime: "CLANKY_CODING_HARNESS_RUNTIME",
	codexOllamaHome: "CLANKY_CODEX_OLLAMA_HOME",
} as const;

export const CODING_HARNESS_IDS = ["clanky", "claude", "codex", "opencode", "custom"] as const;
export const LAUNCHABLE_CODING_HARNESS_IDS = ["claude", "codex", "opencode"] as const;
export const CODING_HARNESS_LAUNCHERS = ["default", "ollama"] as const;
export const CODING_RUNTIMES = ["clanky", "native", "opencode"] as const;
export const PERFORMERS = ["clanky", "claude", "codex", "opencode"] as const;

export type CodingHarnessId = (typeof CODING_HARNESS_IDS)[number];
export type LaunchableCodingHarnessId = (typeof LAUNCHABLE_CODING_HARNESS_IDS)[number];
export type CodingHarnessLauncher = (typeof CODING_HARNESS_LAUNCHERS)[number];
export type CodingRuntime = (typeof CODING_RUNTIMES)[number];
export type Performer = (typeof PERFORMERS)[number];

export type CodingHarnessProfile = {
	id: CodingHarnessId;
	label: string;
	description: string;
	performer: Performer;
	runtime: CodingRuntime;
	launcher?: CodingHarnessLauncher;
	model?: string;
	command?: readonly string[];
};

export type CodingHarnessEnv = Record<string, string | undefined>;

export const DEFAULT_CODING_HARNESS: CodingHarnessId = "clanky";
export const ALL_CODING_HARNESSES: readonly CodingHarnessId[] = CODING_HARNESS_IDS;

export const BUILTIN_CODING_HARNESSES: Record<Exclude<CodingHarnessId, "custom">, CodingHarnessProfile> = {
	clanky: {
		id: "clanky",
		label: "Clanky-managed",
		description: "Clanky runtime pane using Clanky's configured coding skills",
		performer: "clanky",
		runtime: "clanky",
	},
	claude: {
		id: "claude",
		label: "Claude Code",
		description: "Claude Code CLI pane using Claude Code's native coding harness",
		performer: "claude",
		runtime: "native",
		launcher: "default",
	},
	codex: {
		id: "codex",
		label: "Codex",
		description: "Codex CLI pane using Codex's native coding harness",
		performer: "codex",
		runtime: "native",
		launcher: "default",
	},
	opencode: {
		id: "opencode",
		label: "OpenCode",
		description: "OpenCode pane using OpenCode's native coding harness",
		performer: "opencode",
		runtime: "opencode",
		launcher: "default",
	},
};

const OLLAMA_HARNESS_EXTRA_ARGS: Record<LaunchableCodingHarnessId, readonly string[]> = {
	claude: ["--dangerously-skip-permissions", "{KICKOFF}"],
	codex: ["--dangerously-bypass-approvals-and-sandbox", "{KICKOFF}"],
	opencode: ["run", "{KICKOFF}"],
};

export function codingHarnessLauncherEnvKey(id: LaunchableCodingHarnessId): string {
	return `CLANKY_CODING_HARNESS_${id.toUpperCase()}_LAUNCHER`;
}

export function codingHarnessModelEnvKey(id: LaunchableCodingHarnessId): string {
	return `CLANKY_CODING_HARNESS_${id.toUpperCase()}_MODEL`;
}

export function parseCodingHarnessId(value: string | undefined): CodingHarnessId | undefined {
	const normalized = normalizeToken(value);
	return CODING_HARNESS_IDS.find((id) => normalizeToken(id) === normalized);
}

export function parseAllowedCodingHarnesses(value: string | undefined): readonly CodingHarnessId[] | undefined {
	const trimmed = value?.trim();
	if (trimmed === undefined || trimmed.length === 0) return undefined;
	if (normalizeToken(trimmed) === "all") return ALL_CODING_HARNESSES;
	const out: CodingHarnessId[] = [];
	for (const token of trimmed.split(/[\s,]+/)) {
		const id = parseCodingHarnessId(token);
		if (id === undefined) throw new Error(`unknown coding harness '${token}' in allowlist`);
		if (!out.includes(id)) out.push(id);
	}
	if (out.length === 0) throw new Error("coding harness allowlist must include at least one harness");
	return out;
}

export function allowedCodingHarnesses(env: CodingHarnessEnv = process.env): readonly CodingHarnessId[] {
	return parseAllowedCodingHarnesses(env[CLANKY_CODING_HARNESS_ENV.allowed]) ?? ALL_CODING_HARNESSES;
}

export function isCodingHarnessAllowed(id: CodingHarnessId, env: CodingHarnessEnv = process.env): boolean {
	return allowedCodingHarnesses(env).includes(id);
}

export function parseCodingRuntime(value: string | undefined): CodingRuntime | undefined {
	const normalized = normalizeToken(value);
	return CODING_RUNTIMES.find((runtime) => normalizeToken(runtime) === normalized);
}

export function parseCodingHarnessLauncher(value: string | undefined): CodingHarnessLauncher | undefined {
	const normalized = normalizeToken(value);
	if (normalized === "default" || normalized === "native") return "default";
	if (normalized === "ollama" || normalized === "local") return "ollama";
	return undefined;
}

export function parseLaunchableCodingHarnessId(value: string | undefined): LaunchableCodingHarnessId | undefined {
	const normalized = normalizeToken(value);
	return LAUNCHABLE_CODING_HARNESS_IDS.find((id) => normalizeToken(id) === normalized);
}

export function parsePerformer(value: string | undefined): Performer | undefined {
	const normalized = normalizeToken(value);
	return PERFORMERS.find((performer) => normalizeToken(performer) === normalized);
}

export function defaultCodingRuntimeForHarness(id: CodingHarnessId): CodingRuntime {
	if (id === "clanky") return "clanky";
	if (id === "opencode") return "opencode";
	return "native";
}

export function inferCodingRuntimeFromCommand(command: readonly string[] | undefined): CodingRuntime | undefined {
	const integration = ollamaLaunchIntegration(command);
	if (integration === "opencode") return "opencode";
	if (integration === "claude" || integration === "codex") return "native";
	const executable = command?.[0];
	if (executable === undefined) return undefined;
	return executableBasename(executable).includes("opencode") ? "opencode" : undefined;
}

export function inferPerformerFromCommand(command: readonly string[] | undefined): Performer {
	const integration = ollamaLaunchIntegration(command);
	if (integration === "claude" || integration === "codex" || integration === "opencode") return integration;
	const executable = command?.[0];
	const base = executable === undefined ? "" : executableBasename(executable);
	if (base.includes("clanky")) return "clanky";
	if (base.includes("opencode")) return "opencode";
	if (base.includes("codex")) return "codex";
	return "claude";
}

export function parseHarnessCommand(value: string | undefined): string[] | undefined {
	const trimmed = value?.trim();
	if (trimmed === undefined || trimmed.length === 0) return undefined;
	if (trimmed.startsWith("[")) {
		const parsed = JSON.parse(trimmed) as unknown;
		if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === "string")) {
			throw new Error("custom harness command JSON must be an array of strings");
		}
		return parsed.filter((item) => item.length > 0);
	}
	return splitCommandLine(trimmed);
}

export function splitCommandLine(input: string): string[] {
	const args: string[] = [];
	let current = "";
	let quote: "'" | '"' | undefined;
	let escaping = false;
	for (const char of input) {
		if (escaping) {
			current += char;
			escaping = false;
			continue;
		}
		if (char === "\\" && quote !== "'") {
			escaping = true;
			continue;
		}
		if (quote !== undefined) {
			if (char === quote) quote = undefined;
			else current += char;
			continue;
		}
		if (char === "'" || char === '"') {
			quote = char;
			continue;
		}
		if (/\s/.test(char)) {
			if (current.length > 0) {
				args.push(current);
				current = "";
			}
			continue;
		}
		current += char;
	}
	if (escaping) current += "\\";
	if (quote !== undefined) throw new Error(`unterminated ${quote} quote in command`);
	if (current.length > 0) args.push(current);
	return args;
}

export function serializeCommandLine(command: readonly string[]): string {
	return command.map(quoteCommandArg).join(" ");
}

export function resolveCodingHarness(input: {
	harness?: CodingHarnessId;
	performer?: Performer;
	command?: readonly string[];
	runtime?: CodingRuntime;
	env?: CodingHarnessEnv;
}): CodingHarnessProfile {
	const env = input.env ?? process.env;
	const command = nonEmptyCommand(input.command);
	if (command !== undefined) {
		const profile = {
			id: input.harness ?? "custom",
			label: input.harness === undefined ? "Custom" : harnessLabel(input.harness),
			description: "Explicit coding harness command",
			performer: input.performer ?? inferPerformerFromCommand(command),
			runtime: input.runtime ?? inferCodingRuntimeFromCommand(command) ?? defaultCodingRuntimeForHarness(input.harness ?? "custom"),
			command,
		};
		assertCodingHarnessAllowed(profile.id, env);
		return profile;
	}

	if (input.harness !== undefined) {
		assertCodingHarnessAllowed(input.harness, env);
		return resolveHarnessById(input.harness, input.runtime, env);
	}

	if (input.performer !== undefined) {
		const id = harnessIdForPerformer(input.performer);
		assertCodingHarnessAllowed(id, env);
		if (id !== "custom") return resolveHarnessById(id, input.runtime, env);
		const profile = {
			id,
			label: id === "custom" ? performerLabel(input.performer) : harnessLabel(id),
			description: "Explicit performer selection",
			performer: input.performer,
			runtime: input.runtime ?? defaultRuntimeForPerformer(input.performer),
		};
		return profile;
	}

	const configured = parseCodingHarnessId(env[CLANKY_CODING_HARNESS_ENV.id]);
	const selected = automaticCodingHarness(configured, env);
	const configuredRuntime = configured === selected ? parseCodingRuntime(env[CLANKY_CODING_HARNESS_ENV.runtime]) : undefined;
	return resolveHarnessById(selected, input.runtime ?? configuredRuntime, env);
}

function assertCodingHarnessAllowed(id: CodingHarnessId, env: CodingHarnessEnv): void {
	const allowed = allowedCodingHarnesses(env);
	if (!allowed.includes(id)) {
		throw new Error(`coding harness '${id}' is not allowed; allowed harnesses: ${allowed.join(", ")}`);
	}
}

function automaticCodingHarness(configured: CodingHarnessId | undefined, env: CodingHarnessEnv): CodingHarnessId {
	const allowed = allowedCodingHarnesses(env);
	if (configured !== undefined && allowed.includes(configured)) return configured;
	if (allowed.includes(DEFAULT_CODING_HARNESS)) return DEFAULT_CODING_HARNESS;
	return allowed[0] ?? DEFAULT_CODING_HARNESS;
}

function resolveHarnessById(
	id: CodingHarnessId,
	runtime: CodingRuntime | undefined,
	env: CodingHarnessEnv | undefined,
): CodingHarnessProfile {
	if (id !== "custom") {
		const profile = BUILTIN_CODING_HARNESSES[id];
		const launchable = parseLaunchableCodingHarnessId(id);
		const launcher = launchable === undefined
			? undefined
			: parseCodingHarnessLauncher(env?.[codingHarnessLauncherEnvKey(launchable)]) ?? profile.launcher ?? "default";
		const model = launchable === undefined ? undefined : nonEmpty(env?.[codingHarnessModelEnvKey(launchable)]);
		const command = launchable !== undefined && launcher === "ollama" ? ollamaHarnessCommand(launchable, model, env) : undefined;
		return { ...profile, runtime: runtime ?? profile.runtime, launcher, model, command };
	}
	const command = parseHarnessCommand(env?.[CLANKY_CODING_HARNESS_ENV.command]);
	if (command === undefined || command.length === 0) {
		throw new Error("custom coding harness requires CLANKY_CODING_HARNESS_COMMAND or an explicit command");
	}
	return {
		id,
		label: "Custom",
		description: "User-configured coding harness command",
		performer: inferPerformerFromCommand(command),
		runtime: runtime ?? inferCodingRuntimeFromCommand(command) ?? "native",
		command,
	};
}

function harnessLabel(id: CodingHarnessId): string {
	if (id === "custom") return "Custom";
	return BUILTIN_CODING_HARNESSES[id].label;
}

function harnessIdForPerformer(performer: Performer): CodingHarnessId {
	if (performer === "clanky") return "clanky";
	if (performer === "claude") return "claude";
	if (performer === "codex") return "codex";
	if (performer === "opencode") return "opencode";
	return "custom";
}

function defaultRuntimeForPerformer(performer: Performer): CodingRuntime {
	if (performer === "clanky") return "clanky";
	if (performer === "opencode") return "opencode";
	return "native";
}

function performerLabel(performer: Performer): string {
	if (performer === "claude") return "Claude Code";
	if (performer === "codex") return "Codex";
	if (performer === "opencode") return "OpenCode";
	return "Clanky-managed";
}

function normalizeToken(value: string | undefined): string {
	return (value ?? "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function executableBasename(executable: string): string {
	return executable.split(/[\\/]/).pop()?.toLowerCase() ?? executable.toLowerCase();
}

// `ollama launch codex` rewrites the codex config dir (CODEX_HOME, default
// ~/.codex) to route codex at the local Ollama server. Give Ollama-launched codex
// workers an isolated CODEX_HOME so they never clobber the user's subscription
// config, letting a local codex worker and a gpt-5.x subscription codex worker run
// side by side. Override the location with CLANKY_CODEX_OLLAMA_HOME. The home is
// shared across concurrent Ollama codex workers; the per-worker model is pinned by
// the `--model` flag, so the routing config they share is identical.
export function ollamaCodexHome(env: CodingHarnessEnv = process.env): string {
	const configured = nonEmpty(env[CLANKY_CODING_HARNESS_ENV.codexOllamaHome]);
	if (configured !== undefined) return configured;
	return join(nonEmpty(env.HOME) ?? homedir(), ".clanky", "codex-ollama-home");
}

function ollamaHarnessCommand(
	id: LaunchableCodingHarnessId,
	model: string | undefined,
	env: CodingHarnessEnv | undefined,
): readonly string[] {
	// Only codex persists routing into its config dir; isolate just that home.
	const command = id === "codex" ? ["env", `CODEX_HOME=${ollamaCodexHome(env)}`] : [];
	command.push("ollama", "launch", id, "--yes");
	if (model !== undefined) command.push("--model", model);
	command.push("--", ...OLLAMA_HARNESS_EXTRA_ARGS[id]);
	return command;
}

function ollamaLaunchIntegration(command: readonly string[] | undefined): LaunchableCodingHarnessId | undefined {
	if (command === undefined) return undefined;
	// Skip a leading `env VAR=VAL ...` prefix (used to isolate codex's CODEX_HOME).
	let i = 0;
	if (executableBasename(command[i] ?? "") === "env") {
		i++;
		while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(command[i] ?? "")) i++;
	}
	if (executableBasename(command[i] ?? "") !== "ollama") return undefined;
	if (command[i + 1] !== "launch") return undefined;
	return parseLaunchableCodingHarnessId(command[i + 2]);
}

function nonEmptyCommand(command: readonly string[] | undefined): string[] | undefined {
	const filtered = command?.filter((arg) => arg.length > 0);
	return filtered !== undefined && filtered.length > 0 ? [...filtered] : undefined;
}

function nonEmpty(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
}

function quoteCommandArg(arg: string): string {
	if (arg.length === 0) return "''";
	if (!/[\s"'\\]/.test(arg)) return arg;
	return `'${arg.replace(/'/g, `'"'"'`)}'`;
}
