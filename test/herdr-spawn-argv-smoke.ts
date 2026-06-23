import { stat } from "node:fs/promises";
import { buildWorkerKickoff, resolvePaneCwd, resolvePerformerArgv, resolveWorkerSkillPath } from "../agent/tools/herdr_spawn.ts";

function expectEqual(actual: unknown, expected: unknown, label: string): void {
	const actualJson = JSON.stringify(actual);
	const expectedJson = JSON.stringify(expected);
	if (actualJson !== expectedJson) {
		throw new Error(`${label}: expected ${expectedJson}, got ${actualJson}`);
	}
}

const task = "TASK";

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

expectEqual(await resolvePaneCwd(undefined), process.cwd(), "omitted cwd uses process cwd");
expectEqual(await resolvePaneCwd(""), process.cwd(), "empty cwd uses process cwd");

const workerSkillPath = resolveWorkerSkillPath();
const workerSkillStats = await stat(workerSkillPath);
if (!workerSkillStats.isFile()) throw new Error(`worker skill path is not a file: ${workerSkillPath}`);

const kickoff = buildWorkerKickoff({ agent: "clanky:docs", task: "Do the docs task.", cwd: process.cwd() });
for (const expected of ["clanky:docs", "skills/clanky-herdr-worker/SKILL.md", "Do the docs task."]) {
	if (!kickoff.includes(expected)) throw new Error(`kickoff missing ${expected}`);
}
if (kickoff.includes("Herdr coordination")) throw new Error("kickoff should point at the worker skill, not inline the protocol");

console.log("herdr_spawn argv smoke OK");
