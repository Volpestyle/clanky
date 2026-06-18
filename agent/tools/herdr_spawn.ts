/**
 * The eve -> herdr-pane spawn seam (SPEC.md §4.3, §5.2).
 *
 * Clanky's one way to do parallel or watchable work: spawn a performer as a
 * visible herdr pane (`clanky:<slug>`), never a hidden in-process subagent.
 * Runs in the eve host process, so it reaches the local herdr socket directly.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { defineTool } from "eve/tools";
import { never } from "eve/tools/approval";
import { z } from "zod";

const run = promisify(execFile);

const KICKOFF_TOKEN = "{KICKOFF}";
const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;

// Default performer command lines. {KICKOFF} is replaced by the task brief.
// Workers run in visible Herdr panes, so use each CLI's no-approval mode to keep
// them from stalling on unattended permission prompts.
const PERFORMER_ARGV: Record<string, readonly string[]> = {
	claude: ["claude", "--dangerously-skip-permissions", KICKOFF_TOKEN],
	codex: ["codex", "--dangerously-bypass-approvals-and-sandbox", KICKOFF_TOKEN],
};

function applyKickoff(argv: readonly string[], task: string): string[] {
	const out = argv.map((a) => (a === KICKOFF_TOKEN ? task : a));
	if (!argv.includes(KICKOFF_TOKEN)) out.push(task);
	return out;
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
		"Spawn a performer (claude, codex, or a custom command) as a visible herdr pane named clanky:<slug> and give it a task. Use for any parallel or watchable work instead of doing it in-process.",
	inputSchema: z.object({
		slug: z.string().describe("kebab-case worker name; the pane is clanky:<slug>"),
		task: z.string().describe("the kickoff brief the performer starts with"),
		performer: z.enum(["claude", "codex"]).default("claude").describe("which agent to run (ignored if command is set)"),
		cwd: z.string().optional().describe("working directory for the pane"),
		command: z
			.array(z.string())
			.optional()
			.describe("raw argv override; the token {KICKOFF} is replaced by task, else task is appended"),
	}),
	async execute(input) {
		const { slug, task, performer, cwd, command } = input;
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

		const argv = applyKickoff(command ?? PERFORMER_ARGV[performer], task);
		const startArgs = ["agent", "start", agent];
		if (cwd) startArgs.push("--cwd", cwd);
		startArgs.push("--no-focus", "--", ...argv);

		const started = parseAgent(await herdr(startArgs));
		return {
			agent,
			paneId: started?.pane_id ?? null,
			tabId: started?.tab_id ?? null,
			workspaceId: started?.workspace_id ?? null,
			performer: command ? "custom" : performer,
			started: true,
		};
	},
});
