/**
 * Smoke test for the TUI ledger that feeds face-side activity to the eve brain
 * as clientContext. Verifies recording/summarization, spawn-activity gating,
 * roster formatting, and the assembled context message (including the empty case
 * that must add no tokens to idle chats).
 */
import {
	buildTuiContextMessage,
	formatWorkerRosterForBrain,
	TuiLedger,
} from "../agent/lib/clanky-tui-ledger.ts";
import type { HerdrAgentInfo } from "../agent/tools/herdr_spawn.ts";

function assert(condition: boolean, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

// Empty ledger -> no context (idle chats pay nothing).
const empty = new TuiLedger();
assert(empty.actionLines().length === 0, "fresh ledger has no actions");
assert(!empty.hasSpawnActivity(), "fresh ledger has no spawn activity");
assert(
	buildTuiContextMessage({ actions: [], workers: [] }) === undefined,
	"empty actions and workers yield no context message",
);

// Records a multi-line, ANSI-colored spawn result down to one plain line.
const ledger = new TuiLedger();
ledger.record(
	"/spawn",
	"[32mSpawned `clanky:tom`[0m - Claude Code (claude · native) · pane w1:p4M.\nTranscript: read it\nWatch with /agents.",
	"success",
);
const lines = ledger.actionLines();
assert(lines.length === 1, `expected 1 action line, got ${lines.length}`);
assert(!/\[/u.test(lines[0] ?? ""), "summary must strip ANSI escapes");
assert((lines[0] ?? "").includes("clanky:tom"), "summary keeps the worker slug");
assert(!(lines[0] ?? "").includes("Transcript"), "summary keeps only the first line");
assert(ledger.hasSpawnActivity(), "successful /spawn flips spawn-activity on");

// Non-spawn commands record but do not request the roster.
const modelLedger = new TuiLedger();
modelLedger.record("/model", "Model set to openai/gpt-5.5 (medium effort)", "success");
assert(!modelLedger.hasSpawnActivity(), "non-spawn command does not flip spawn-activity");
assert(modelLedger.actionLines().length === 1, "non-spawn command is still recorded");

// Errors are tagged so the brain knows the action failed.
const errLedger = new TuiLedger();
errLedger.record("/spawn", "Spawn failed: herdr is not on PATH", "error");
assert((errLedger.actionLines()[0] ?? "").includes("(error)"), "error tone is surfaced");

// Rolling cap keeps only the most recent entries.
const capped = new TuiLedger();
for (let i = 0; i < 15; i += 1) capped.record("/model", `change ${i}`, "success");
assert(capped.actionLines().length === 10, "ledger caps at 10 entries");
assert((capped.actionLines()[9] ?? "").includes("change 14"), "newest entry retained");
assert(!capped.actionLines().some((line) => line.includes("change 0")), "oldest entry dropped");

// Roster formatting is plain text the brain can read.
const workers: HerdrAgentInfo[] = [
	{
		agent: "clanky:tom",
		agentStatus: "working",
		cwd: "/home/u/dev/clanky",
		foregroundCwd: "/home/u/dev/clanky",
		focused: false,
		paneId: "w1:p4M",
		tabId: "w1:t0",
		workspaceId: "w1",
		terminalId: "t1",
	},
];
const roster = formatWorkerRosterForBrain(workers);
assert(roster.length === 1, "one roster line per worker");
assert((roster[0] ?? "").includes("clanky:tom") && (roster[0] ?? "").includes("w1:p4M"), "roster line carries slug and pane");

// Assembled message contains both sections and the resolution hint.
const message = buildTuiContextMessage({ actions: lines, workers: roster });
assert(message !== undefined, "actions+workers produce a message");
assert(message.includes("Recent TUI actions"), "message has the actions section");
assert(message.includes("Workers on the herdr stage"), "message has the roster section");
assert(message.includes("Clanky TUI context"), "message carries the framing header");

console.log("clanky-tui-ledger smoke passed");
