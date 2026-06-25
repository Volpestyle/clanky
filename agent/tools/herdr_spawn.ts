/**
 * The eve -> herdr-pane spawn seam (SPEC.md §4.3, §5.2).
 *
 * Clanky's one way to do parallel or watchable work: spawn a performer as a
 * visible herdr pane (`clanky:<slug>`), never a hidden in-process subagent.
 * Runs in the eve host process, so it reaches the local herdr socket directly.
 */
import { execFile } from "node:child_process";
import { mkdir, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { defineTool } from "eve/tools";
import { never } from "eve/tools/approval";
import { z } from "zod";
import {
	CODING_HARNESS_IDS,
	CODING_RUNTIMES,
	PERFORMERS,
	type CodingHarnessId,
	ollamaCodexHome,
	type Performer,
	resolveCodingHarness,
} from "../lib/coding-harness.ts";
import { resolveClankyHome } from "../lib/paths.ts";
import { newTranscriptRunId, resolveTranscriptRunPath, resolveTranscriptSession } from "../lib/transcripts.ts";

const run = promisify(execFile);

const KICKOFF_TOKEN = "{KICKOFF}";
const WORKER_SKILL_RELATIVE_PATH = "skills/clanky-herdr-worker/SKILL.md";
const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;
type ResolvedPerformer = Performer | "custom";

// Default performer command lines. {KICKOFF} is replaced by the task brief.
// Workers run in visible Herdr panes, so use each CLI's no-approval mode to keep
// them from stalling on unattended permission prompts.
const PERFORMER_ARGV: Record<Performer, readonly string[]> = {
	clanky: ["clanky", "worker", KICKOFF_TOKEN],
	claude: ["claude", "--dangerously-skip-permissions", KICKOFF_TOKEN],
	codex: ["codex", "--dangerously-bypass-approvals-and-sandbox", KICKOFF_TOKEN],
	opencode: ["opencode", "run", KICKOFF_TOKEN],
};

function applyKickoff(argv: readonly string[], task: string): string[] {
	const out = argv.map((a) => (a === KICKOFF_TOKEN ? task : a));
	if (!argv.includes(KICKOFF_TOKEN)) out.push(task);
	return out;
}

export function resolvePerformerArgv(input: {
	performer: Performer;
	task: string;
	command?: readonly string[];
}): { argv: string[]; performer: ResolvedPerformer } {
	const customCommand =
		input.command !== undefined &&
		input.command.length > 0 &&
		!(input.command.length === 1 && input.command[0] === input.performer);
	const argvTemplate = customCommand ? input.command ?? [] : PERFORMER_ARGV[input.performer];
	const argv = applyKickoff(argvTemplate, input.task);
	const executable = argv[0];
	if (executable === undefined || executable.trim().length === 0) {
		throw new Error("custom command must start with a non-empty executable; omit command to use the performer default");
	}
	return { argv, performer: customCommand ? "custom" : input.performer };
}

export function wrapTranscriptArgv(input: {
	agent: string;
	cwd: string;
	runId: string;
	argv: readonly string[];
	clankyCliPath?: string;
	env?: NodeJS.ProcessEnv;
}): string[] {
	return [
		...transcriptEnvPrefix(input.env),
		process.execPath,
		input.clankyCliPath ?? resolveClankyCliPath(),
		"transcript-run",
		"--agent",
		input.agent,
		"--cwd",
		input.cwd,
		"--run-id",
		input.runId,
		"--",
		...input.argv,
	];
}

interface HerdrAgent {
	name: string;
	pane_id: string;
	tab_id: string;
	workspace_id: string;
	agent_status?: string;
}

async function herdr(args: string[]): Promise<string> {
	try {
		const { stdout } = await run("herdr", args, { encoding: "utf8" });
		return stdout.trim();
	} catch (error) {
		const err = error as NodeJS.ErrnoException & { stderr?: string };
		if (err.code === "ENOENT") {
			throw new Error("herdr is not on PATH. Clanky must run inside a herdr session to spawn panes.");
		}
		throw new Error(`herdr ${args[0]} ${args[1] ?? ""} failed: ${err.stderr || err.message}`);
	}
}

export async function resolvePaneCwd(cwd: string | undefined): Promise<string> {
	const paneCwd = cwd?.trim() ? cwd : process.cwd();
	let stats;
	try {
		stats = await stat(paneCwd);
	} catch (error) {
		const err = error as NodeJS.ErrnoException;
		if (err.code === "ENOENT") {
			throw new Error(
				`cwd '${paneCwd}' does not exist on the herdr host. herdr_spawn starts host panes, not sandbox commands; omit cwd to use '${process.cwd()}' or pass a host path.`,
			);
		}
		throw error;
	}
	if (!stats.isDirectory()) throw new Error(`cwd '${paneCwd}' is not a directory`);
	return paneCwd;
}

export function resolveWorkerSkillPath(repoCwd = process.cwd()): string {
	return resolve(repoCwd, WORKER_SKILL_RELATIVE_PATH);
}

export function resolveClankyCliPath(repoCwd = process.cwd()): string {
	return resolve(repoCwd, "bin/clanky.ts");
}

// Pin the runner to the same transcript root/session the spawn tool predicted,
// instead of trusting the worker pane to inherit a matching environment. The
// worker pane may carry a different HERDR_SESSION than the eve host, which would
// otherwise write the transcript where readers never look.
function transcriptEnvPrefix(env: NodeJS.ProcessEnv = process.env): string[] {
	return ["env", `CLANKY_HOME=${resolveClankyHome(env)}`, `HERDR_SESSION=${resolveTranscriptSession(env)}`];
}

export function buildWorkerKickoff(input: {
	agent: string;
	task: string;
	cwd: string;
	workerSkillPath?: string;
}): string {
	const workerSkillPath = input.workerSkillPath ?? resolveWorkerSkillPath();
	return [
		`You are ${input.agent}, a visible Clanky worker running in a Herdr pane.`,
		`Host cwd: ${input.cwd}.`,
		"",
		"For durable worker history, use:",
		`clanky transcript read ${input.agent} --lines N`,
		"Use Herdr for current status, visible screen state, and sending input.",
		"",
		"Before doing the task, read and follow this Clanky Herdr worker skill file:",
		workerSkillPath,
		"",
		"Do not load Clanky coding skill package paths from this prompt. If this process is the Clanky runtime, use Clanky's configured skills; otherwise use your own agent/runtime's native coding behavior.",
		"",
		"If the skill file is unavailable, say so in your output and continue with best judgment.",
		"",
		"Task:",
		input.task,
	].join("\n");
}

/** herdr CLI prints a JSON envelope `{ id, result: { agent } }`; pull the agent out. */
function parseAgent(stdout: string): HerdrAgent | null {
	try {
		const env = JSON.parse(stdout) as { result?: { agent?: HerdrAgent } };
		return env.result?.agent ?? null;
	} catch {
		return null;
	}
}

export default defineTool({
	needsApproval: never(),
	description:
		"Spawn an allowed coding harness/performer (clanky, claude, codex, opencode, or custom command) as a visible herdr pane named clanky:<slug> and give it a task. Omit harness/performer to let Clanky pick from the allowed set. The /harness TUI command controls the allowlist; direct /harness <id> commands configure preferred fallback and default-vs-Ollama worker launch models. Load clanky-herdr-operator before spawn/fan-out work. Spawned workers receive only the Herdr worker coordination skill; Clanky's coding skills are available only when the runtime is clanky.",
	inputSchema: z.object({
		slug: z.string().describe("kebab-case worker name; the pane is clanky:<slug>"),
		task: z.string().describe("the kickoff brief the performer starts with"),
		harness: z
			.enum(CODING_HARNESS_IDS)
			.optional()
			.describe("allowed coding harness profile to run (clanky, claude, codex, opencode, custom); omit to use automatic selection from the allowed set"),
		performer: z
			.enum(PERFORMERS)
			.optional()
			.describe("lower-level performer override (clanky, claude, codex, or opencode); omit to use harness"),
		codingRuntime: z
			.enum(CODING_RUNTIMES)
			.optional()
			.describe("runtime instruction mode; clanky allows Clanky coding skills, native/opencode uses the harness internals"),
		cwd: z
			.string()
			.optional()
			.describe("host working directory for the pane; omit to use Clanky's current repo cwd; do not use sandbox paths like /workspace"),
		command: z
			.array(z.string())
			.optional()
			.describe("raw argv override for custom commands only; omit for built-in performers, never pass an empty array"),
		transcript: z
			.boolean()
			.optional()
			.describe("wrap the performer in Clanky's local transcript runner; defaults to true, set false only for debugging"),
	}),
	async execute(input) {
		const { slug, task, harness, performer, codingRuntime, cwd, command, transcript = true } = input;
		if (!SLUG_RE.test(slug)) {
			throw new Error(`invalid slug '${slug}' (use lowercase letters, digits, hyphens)`);
		}
		const agent = `clanky:${slug}`;

		// Refuse to clobber an existing worker of the same name.
		const exists = await herdr(["agent", "get", agent]).then(
			() => true,
			() => false,
		);
		if (exists) {
			throw new Error(`a worker named ${agent} already exists; pick a different slug`);
		}

		const paneCwd = await resolvePaneCwd(cwd);
		const kickoff = buildWorkerKickoff({ agent, task, cwd: paneCwd });
		const harnessProfile = resolveCodingHarness({
			harness: harness as CodingHarnessId | undefined,
			performer,
			command,
			runtime: codingRuntime,
		});
		// Ollama-launched codex reroutes its config dir; isolate that home so it
		// can't clobber the subscription codex worker's ~/.codex.
		if (harnessProfile.launcher === "ollama" && harnessProfile.performer === "codex") {
			await mkdir(ollamaCodexHome(), { recursive: true });
		}
		const resolved = resolvePerformerArgv({
			performer: harnessProfile.performer,
			task: kickoff,
			command: harnessProfile.command,
		});
		const runId = transcript ? newTranscriptRunId() : undefined;
		const transcriptPath = runId === undefined ? undefined : resolveTranscriptRunPath({ agent, runId });
		const launchArgv =
			runId === undefined
				? resolved.argv
				: wrapTranscriptArgv({ agent, cwd: paneCwd, runId, argv: resolved.argv });
		const startArgs = ["agent", "start", agent];
		startArgs.push("--cwd", paneCwd, "--no-focus", "--", ...launchArgv);

		const started = parseAgent(await herdr(startArgs));
		return {
			agent,
			paneId: started?.pane_id ?? null,
			tabId: started?.tab_id ?? null,
			workspaceId: started?.workspace_id ?? null,
			performer: resolved.performer,
			harness: harnessProfile.id,
			harnessLabel: harnessProfile.label,
			codingRuntime: harnessProfile.runtime,
			transcript: {
				enabled: runId !== undefined,
				runId: runId ?? null,
				path: transcriptPath ?? null,
				readCommand: runId === undefined ? null : `clanky transcript read ${agent} --lines 300`,
			},
			started: true,
		};
	},
});
