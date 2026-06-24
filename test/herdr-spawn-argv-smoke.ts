import { stat } from "node:fs/promises";
import {
	codingHarnessLauncherEnvKey,
	codingHarnessModelEnvKey,
	parseAllowedCodingHarnesses,
	parseHarnessCommand,
	resolveCodingHarness,
	serializeCommandLine,
	splitCommandLine,
} from "../agent/lib/coding-harness.ts";
import {
	buildWorkerKickoff,
	resolvePaneCwd,
	resolvePerformerArgv,
	resolveWorkerSkillPath,
} from "../agent/tools/herdr_spawn.ts";

function expectEqual(actual: unknown, expected: unknown, label: string): void {
	const actualJson = JSON.stringify(actual);
	const expectedJson = JSON.stringify(expected);
	if (actualJson !== expectedJson) {
		throw new Error(`${label}: expected ${expectedJson}, got ${actualJson}`);
	}
}

function expectThrows(fn: () => unknown, label: string): void {
	let threw = false;
	try {
		fn();
	} catch {
		threw = true;
	}
	if (!threw) throw new Error(`${label}: expected function to throw`);
}

const task = "TASK";

expectEqual(resolvePerformerArgv({ performer: "clanky", task }), {
	argv: ["clanky", "worker", task],
	performer: "clanky",
}, "omitted command uses clanky default");

expectEqual(resolvePerformerArgv({ performer: "claude", task }), {
	argv: ["claude", "--dangerously-skip-permissions", task],
	performer: "claude",
}, "omitted command uses claude default");

expectEqual(resolvePerformerArgv({ performer: "claude", task, command: [] }), {
	argv: ["claude", "--dangerously-skip-permissions", task],
	performer: "claude",
}, "empty command uses claude default");

expectEqual(resolvePerformerArgv({ performer: "claude", task, command: ["claude"] }), {
	argv: ["claude", "--dangerously-skip-permissions", task],
	performer: "claude",
}, "bare claude command uses claude default");

expectEqual(resolvePerformerArgv({ performer: "codex", task, command: [] }), {
	argv: ["codex", "--dangerously-bypass-approvals-and-sandbox", task],
	performer: "codex",
}, "empty command uses codex default");

expectEqual(resolvePerformerArgv({ performer: "opencode", task, command: [] }), {
	argv: ["opencode", "run", task],
	performer: "opencode",
}, "empty command uses opencode default");

const ollamaCodex = resolveCodingHarness({
	harness: "codex",
	env: {
		[codingHarnessLauncherEnvKey("codex")]: "ollama",
		[codingHarnessModelEnvKey("codex")]: "qwen3-coder:latest",
	},
});
expectEqual({
	id: ollamaCodex.id,
	performer: ollamaCodex.performer,
	runtime: ollamaCodex.runtime,
	launcher: ollamaCodex.launcher,
	model: ollamaCodex.model,
	command: ollamaCodex.command,
}, {
	id: "codex",
	performer: "codex",
	runtime: "native",
	launcher: "ollama",
	model: "qwen3-coder:latest",
	command: ["ollama", "launch", "codex", "--yes", "--model", "qwen3-coder:latest", "--", "--dangerously-bypass-approvals-and-sandbox", "{KICKOFF}"],
}, "codex Ollama harness uses the CLI integration");
if (ollamaCodex.command?.includes("codex-app")) throw new Error("codex Ollama harness must not launch codex-app");
expectEqual(resolvePerformerArgv({ performer: ollamaCodex.performer, task, command: ollamaCodex.command }), {
	argv: ["ollama", "launch", "codex", "--yes", "--model", "qwen3-coder:latest", "--", "--dangerously-bypass-approvals-and-sandbox", task],
	performer: "custom",
}, "codex Ollama harness replaces kickoff token");

const ollamaClaude = resolveCodingHarness({
	harness: "claude",
	env: {
		[codingHarnessLauncherEnvKey("claude")]: "ollama",
		[codingHarnessModelEnvKey("claude")]: "devstral:latest",
	},
});
expectEqual({
	id: ollamaClaude.id,
	performer: ollamaClaude.performer,
	runtime: ollamaClaude.runtime,
	launcher: ollamaClaude.launcher,
	model: ollamaClaude.model,
	command: ollamaClaude.command,
}, {
	id: "claude",
	performer: "claude",
	runtime: "native",
	launcher: "ollama",
	model: "devstral:latest",
	command: ["ollama", "launch", "claude", "--yes", "--model", "devstral:latest", "--", "--dangerously-skip-permissions", "{KICKOFF}"],
}, "claude Ollama harness uses the Claude Code integration");

const defaultClaude = resolveCodingHarness({
	env: {
		CLANKY_CODING_HARNESS: "claude",
		[codingHarnessLauncherEnvKey("claude")]: "ollama",
		[codingHarnessModelEnvKey("claude")]: "devstral:latest",
	},
});
expectEqual(defaultClaude.command, ollamaClaude.command, "configured default harness carries launcher config");

const performerCodex = resolveCodingHarness({
	performer: "codex",
	env: {
		[codingHarnessLauncherEnvKey("codex")]: "ollama",
		[codingHarnessModelEnvKey("codex")]: "qwen3-coder:latest",
	},
});
expectEqual(performerCodex.command, ollamaCodex.command, "explicit codex performer carries launcher config");

expectEqual(resolvePerformerArgv({ performer: "claude", task, command: ["bash", "-lc", "{KICKOFF}"] }), {
	argv: ["bash", "-lc", task],
	performer: "custom",
}, "custom command replaces kickoff token");

expectEqual(resolvePerformerArgv({ performer: "claude", task, command: ["bash", "-lc", "echo ok"] }), {
	argv: ["bash", "-lc", "echo ok", task],
	performer: "custom",
}, "custom command appends kickoff without token");

let rejectedBlankExecutable = false;
try {
	resolvePerformerArgv({ performer: "claude", task, command: [""] });
} catch {
	rejectedBlankExecutable = true;
}
if (!rejectedBlankExecutable) {
	throw new Error("blank custom executable should be rejected");
}

expectEqual(resolveCodingHarness({ env: {} }), {
	id: "clanky",
	label: "Clanky-managed",
	description: "Clanky runtime pane using Clanky's configured coding skills",
	performer: "clanky",
	runtime: "clanky",
}, "empty env uses clanky harness default");

expectEqual(resolveCodingHarness({ env: { CLANKY_CODING_HARNESS: "codex" } }), {
	id: "codex",
	label: "Codex",
	description: "Codex CLI pane using Codex's native coding harness",
	performer: "codex",
	runtime: "native",
	launcher: "default",
}, "codex env selects native codex harness");

expectEqual(parseAllowedCodingHarnesses("clanky, codex opencode"), ["clanky", "codex", "opencode"], "allowlist parses comma and space separators");
expectEqual(parseAllowedCodingHarnesses("all"), ["clanky", "claude", "codex", "opencode", "custom"], "allowlist all expands to every harness");
expectEqual(resolveCodingHarness({ harness: "codex", env: { CLANKY_CODING_HARNESSES: "codex,opencode" } }).id, "codex", "allowed explicit harness resolves");
expectThrows(
	() => resolveCodingHarness({ harness: "claude", env: { CLANKY_CODING_HARNESSES: "codex,opencode" } }),
	"disallowed explicit harness is rejected",
);
expectThrows(
	() => resolveCodingHarness({ env: { CLANKY_CODING_HARNESSES: "codex", CLANKY_CODING_HARNESS: "clanky" } }),
	"disallowed configured default is rejected",
);

expectEqual(resolveCodingHarness({ performer: "claude", env: {} }), {
	id: "claude",
	label: "Claude Code",
	description: "Claude Code CLI pane using Claude Code's native coding harness",
	performer: "claude",
	runtime: "native",
	launcher: "default",
}, "explicit claude performer resolves the claude harness profile");

expectEqual(resolveCodingHarness({ env: { CLANKY_CODING_HARNESS: "codex", CLANKY_CODING_HARNESS_CODEX_LAUNCHER: "ollama", CLANKY_CODING_HARNESS_CODEX_MODEL: "qwen3-coder:latest" } }), {
	id: "codex",
	label: "Codex",
	description: "Codex CLI pane using Codex's native coding harness",
	performer: "codex",
	runtime: "native",
	launcher: "ollama",
	model: "qwen3-coder:latest",
	command: ["ollama", "launch", "codex", "--yes", "--model", "qwen3-coder:latest", "--", "--dangerously-bypass-approvals-and-sandbox", "{KICKOFF}"],
}, "codex ollama launcher builds an ollama launch command");

expectEqual(resolveCodingHarness({ command: ["opencode", "run", "{KICKOFF}"] }), {
	id: "custom",
	label: "Custom",
	description: "Explicit coding harness command",
	performer: "opencode",
	runtime: "opencode",
	command: ["opencode", "run", "{KICKOFF}"],
}, "custom opencode command infers opencode runtime");

expectEqual(parseHarnessCommand("codex --flag 'two words'"), ["codex", "--flag", "two words"], "harness command parses quoted args");
expectEqual(splitCommandLine(serializeCommandLine(["cmd", "two words", "it's ok"])), ["cmd", "two words", "it's ok"], "harness command serialization round-trips");

expectEqual(await resolvePaneCwd(undefined), process.cwd(), "omitted cwd uses process cwd");
expectEqual(await resolvePaneCwd(""), process.cwd(), "empty cwd uses process cwd");

const workerSkillPath = resolveWorkerSkillPath();
const workerSkillStats = await stat(workerSkillPath);
if (!workerSkillStats.isFile()) throw new Error(`worker skill path is not a file: ${workerSkillPath}`);

const kickoff = buildWorkerKickoff({ agent: "clanky:docs", task: "Do the docs task.", cwd: process.cwd() });
for (const expected of [
	"clanky:docs",
	"skills/clanky-herdr-worker/SKILL.md",
	"Do not load Clanky coding skill package paths",
	"Do the docs task.",
]) {
	if (!kickoff.includes(expected)) throw new Error(`kickoff missing ${expected}`);
}
for (const unexpected of [
	"skills/clanky-coding-worker/SKILL.md",
	"skills/clanky-coding-explorer/SKILL.md",
	"skills/clanky-coding-planner/SKILL.md",
	"skills/clanky-coding-reviewer/SKILL.md",
]) {
	if (kickoff.includes(unexpected)) throw new Error(`kickoff should not include Clanky coding skill path ${unexpected}`);
}

if (kickoff.includes("Herdr coordination")) throw new Error("kickoff should point at the worker skill, not inline the protocol");

console.log("herdr_spawn argv smoke OK");
