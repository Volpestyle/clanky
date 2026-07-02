import { resolveTarget, stampMessage } from "../agent/lib/herdr-message.ts";
import {
	classifyWorkerState,
	evaluateSettleProbe,
	formatWakeMessage,
	isSettledAgentStatus,
	parseWatchEventLine,
	SETTLE_QUIET_PROBES_REQUIRED,
	watcherSelfName,
	workerRunPaths,
	workerSlugFromAgent,
} from "../agent/lib/worker-watch.ts";

function expectEqual(actual: unknown, expected: unknown, label: string): void {
	const actualJson = JSON.stringify(actual);
	const expectedJson = JSON.stringify(expected);
	if (actualJson !== expectedJson) {
		throw new Error(`${label}: expected ${expectedJson}, got ${actualJson}`);
	}
}

// Classification: sentinel files are completion truth, agent_status is heuristic.
expectEqual(
	classifyWorkerState({ paneAlive: false, agentStatus: undefined, sentinels: { done: true, blocked: false } }),
	"done",
	"DONE sentinel wins even when the pane is already gone",
);
expectEqual(
	classifyWorkerState({ paneAlive: true, agentStatus: "working", sentinels: { done: true, blocked: false } }),
	"done",
	"DONE sentinel wins over a working status",
);
expectEqual(
	classifyWorkerState({ paneAlive: true, agentStatus: "idle", sentinels: { done: false, blocked: true } }),
	"blocked",
	"BLOCKED sentinel classifies blocked",
);
expectEqual(
	classifyWorkerState({ paneAlive: false, sentinels: { done: false, blocked: false } }),
	"dead",
	"no sentinel and no pane is a silent death",
);
expectEqual(
	classifyWorkerState({ paneAlive: true, agentStatus: "done", sentinels: { done: false, blocked: false } }),
	"idle",
	"settled status without a sentinel is the forgot-the-protocol case",
);
expectEqual(
	classifyWorkerState({ paneAlive: true, agentStatus: "working", sentinels: { done: false, blocked: false } }),
	"running",
	"working with no sentinel keeps waiting",
);
expectEqual(
	classifyWorkerState({ paneAlive: true, agentStatus: "unknown", sentinels: { done: false, blocked: false } }),
	"running",
	"unknown status is not a settle",
);

// Without a run dir the status heuristic is all there is.
expectEqual(classifyWorkerState({ paneAlive: true, agentStatus: "done" }), "done", "no run dir: done status classifies done");
expectEqual(
	classifyWorkerState({ paneAlive: true, agentStatus: "blocked" }),
	"blocked",
	"no run dir: blocked status classifies blocked",
);
expectEqual(classifyWorkerState({ paneAlive: true, agentStatus: "idle" }), "idle", "no run dir: idle status classifies idle");
expectEqual(classifyWorkerState({ paneAlive: true, agentStatus: "working" }), "running", "no run dir: working keeps waiting");
expectEqual(classifyWorkerState({ paneAlive: false }), "dead", "no run dir: gone pane is dead");

expectEqual(isSettledAgentStatus("done"), true, "done is settled");
expectEqual(isSettledAgentStatus("blocked"), true, "blocked is settled");
expectEqual(isSettledAgentStatus("idle"), true, "idle is settled");
expectEqual(isSettledAgentStatus("working"), false, "working is not settled");
expectEqual(isSettledAgentStatus(undefined), false, "missing status is not settled");

// Identity and run-dir layout.
expectEqual(workerSlugFromAgent("clanky:fix-auth"), "fix-auth", "clanky: prefix strips to the slug");
expectEqual(workerSlugFromAgent("bare-name"), "bare-name", "bare agent name passes through");
expectEqual(watcherSelfName("clanky:fix-auth"), "watch:fix-auth", "watcher stamps as watch:<slug>");

const paths = workerRunPaths("/runs/run-20260701-1200-42", "clanky:fix-auth");
expectEqual(paths.runId, "run-20260701-1200-42", "run id is the run dir basename");
expectEqual(paths.workerDir, "/runs/run-20260701-1200-42/workers/fix-auth", "worker dir is workers/<slug>");
expectEqual(paths.donePath, "/runs/run-20260701-1200-42/workers/fix-auth/DONE", "DONE sentinel path");
expectEqual(paths.blockedPath, "/runs/run-20260701-1200-42/workers/fix-auth/BLOCKED", "BLOCKED sentinel path");
expectEqual(paths.resultPath, "/runs/run-20260701-1200-42/workers/fix-auth/result.md", "result.md path");
expectEqual(paths.watchLogPath, "/runs/run-20260701-1200-42/workers/fix-auth/watch.log", "watch.log path");

// Wake message formatting.
expectEqual(
	formatWakeMessage({
		agent: "clanky:fix-auth",
		outcome: "done",
		runId: "run-20260701-1200-42",
		resultPath: "/runs/run-20260701-1200-42/workers/fix-auth/result.md",
		agentStatus: "done",
		hasRunDir: true,
	}),
	"[worker done] clanky:fix-auth run=run-20260701-1200-42 result=/runs/run-20260701-1200-42/workers/fix-auth/result.md",
	"done wake carries run id and result path",
);
expectEqual(
	formatWakeMessage({ agent: "clanky:fix-auth", outcome: "blocked", runId: "run-1", hasRunDir: true }),
	"[worker blocked] clanky:fix-auth run=run-1",
	"blocked wake without a result.md omits result=",
);
expectEqual(
	formatWakeMessage({ agent: "clanky:fix-auth", outcome: "idle", runId: "run-1", agentStatus: "idle", hasRunDir: true }),
	"[worker idle] clanky:fix-auth run=run-1 (agent status idle, no DONE/BLOCKED sentinel — inspect the pane)",
	"idle wake says the sentinel is missing",
);
expectEqual(
	formatWakeMessage({ agent: "clanky:fix-auth", outcome: "dead", runId: "run-1", hasRunDir: true }),
	"[worker dead] clanky:fix-auth run=run-1 (pane gone, no sentinel)",
	"dead wake says the pane is gone",
);
expectEqual(
	formatWakeMessage({ agent: "clanky:fix-auth", outcome: "done", agentStatus: "done", hasRunDir: false }),
	"[worker done] clanky:fix-auth (agent status done, no run dir — classified on status alone)",
	"no run dir wake says classification is status-only",
);
expectEqual(
	formatWakeMessage({ agent: "clanky:fix-auth", outcome: "timeout", runId: "run-1", hasRunDir: true, timeoutMs: 900000 }),
	"[worker timeout] clanky:fix-auth run=run-1 (no completion after 900000ms, watcher exited — re-arm or harvest manually)",
	"timeout wake says the watcher disarmed",
);

// Settle confirmation: agent_status is heuristic (observed live: a pane reads
// idle mid-turn while visibly working), so a status-only settle fires only
// after consecutive probes with a quiet screen. Sentinels and death are truth.
const noSentinels = { done: false, blocked: false };
expectEqual(
	evaluateSettleProbe(
		{ paneAlive: true, agentStatus: "working", sentinels: { done: true, blocked: false }, screenSignature: "a" },
		{ quietProbes: 0 },
	),
	{ kind: "fire", outcome: "done" },
	"DONE sentinel fires immediately, no quiet window needed",
);
expectEqual(
	evaluateSettleProbe({ paneAlive: false, sentinels: noSentinels }, { quietProbes: 0 }),
	{ kind: "fire", outcome: "dead" },
	"pane death fires immediately",
);
expectEqual(
	evaluateSettleProbe({ paneAlive: true, agentStatus: "working", sentinels: noSentinels, screenSignature: "a" }, { quietProbes: 2 }),
	{ kind: "watch" },
	"status back at working abandons confirmation to event waiting",
);
expectEqual(
	evaluateSettleProbe({ paneAlive: true, agentStatus: "unknown", sentinels: noSentinels, screenSignature: "a" }, { quietProbes: 2 }),
	{ kind: "watch" },
	"status lost to unknown abandons confirmation",
);
expectEqual(
	evaluateSettleProbe({ paneAlive: true, agentStatus: "idle", sentinels: noSentinels, screenSignature: "a" }, { quietProbes: 0 }),
	{ kind: "confirming", progress: { quietProbes: 1, screenSignature: "a" } },
	"first settled probe starts the quiet window, does not fire",
);
expectEqual(
	evaluateSettleProbe(
		{ paneAlive: true, agentStatus: "idle", sentinels: noSentinels, screenSignature: "b" },
		{ quietProbes: 2, screenSignature: "a" },
	),
	{ kind: "confirming", progress: { quietProbes: 1, screenSignature: "b" } },
	"a changed screen (mid-turn idle) resets the quiet window instead of firing",
);
expectEqual(
	evaluateSettleProbe(
		{ paneAlive: true, agentStatus: "idle", sentinels: noSentinels, screenSignature: "a" },
		{ quietProbes: SETTLE_QUIET_PROBES_REQUIRED - 1, screenSignature: "a" },
	),
	{ kind: "fire", outcome: "idle" },
	"a settled status with a quiet screen across enough probes fires idle",
);
expectEqual(
	evaluateSettleProbe(
		{ paneAlive: true, agentStatus: "done", screenSignature: "a" },
		{ quietProbes: SETTLE_QUIET_PROBES_REQUIRED - 1, screenSignature: "a" },
	),
	{ kind: "fire", outcome: "done" },
	"no run dir: a quiet done status fires done after confirmation",
);
expectEqual(
	evaluateSettleProbe({ paneAlive: true, agentStatus: "idle", sentinels: noSentinels, screenSignature: "a" }, { quietProbes: 0 }, 1),
	{ kind: "fire", outcome: "idle" },
	"the quiet-probe requirement is tunable",
);

// Event-line decoding: ack, error, agent-status, both pane-death spellings.
expectEqual(
	parseWatchEventLine('{"id":"w1","result":{"type":"subscription_started"}}'),
	{ kind: "subscribed" },
	"subscription ack decodes",
);
expectEqual(
	parseWatchEventLine('{"id":"w1","error":{"code":"pane_not_found","message":"pane w1:p9 not found"}}'),
	{ kind: "error", message: "pane w1:p9 not found" },
	"error envelope decodes",
);
expectEqual(
	parseWatchEventLine(
		'{"event":"pane.agent_status_changed","data":{"pane_id":"w1:p7","workspace_id":"w1","agent_status":"done","agent":"clanky:fix-auth"}}',
	),
	{ kind: "agent-status", paneId: "w1:p7", status: "done" },
	"agent-status subscription event decodes",
);
expectEqual(
	parseWatchEventLine('{"event":"pane_closed","data":{"type":"pane_closed","pane_id":"w1:p7","workspace_id":"w1"}}'),
	{ kind: "pane-gone", paneId: "w1:p7" },
	"snake_case pane_closed event decodes as pane death",
);
expectEqual(
	parseWatchEventLine('{"event":"pane.exited","data":{"pane_id":"w1:p7"}}'),
	{ kind: "pane-gone", paneId: "w1:p7" },
	"pane.exited decodes as pane death",
);
expectEqual(
	parseWatchEventLine('{"event":"tab_created","data":{"type":"tab_created","tab_id":"w1:t1"}}'),
	undefined,
	"unrelated events are ignored",
);
expectEqual(parseWatchEventLine("not json"), undefined, "garbage lines are ignored");
expectEqual(
	parseWatchEventLine('{"event":"pane.agent_status_changed","data":{"pane_id":"w1:p7"}}'),
	undefined,
	"status event without a status is ignored",
);

// Delivery identity: the watcher resolves the notify target with no self-pane
// exclusion (it may wake the pane that armed it) and stamps as watch:<slug>.
const roster = [
	{ paneId: "w1:p1", agent: "clanky:main", status: "idle" },
	{ paneId: "w1:p7", agent: "clanky:fix-auth", status: "done" },
];
const notify = resolveTarget(roster, "clanky:main", "");
expectEqual(notify.ok && notify.pane.paneId, "w1:p1", "notify target resolves against the live roster");
expectEqual(
	stampMessage(watcherSelfName("clanky:fix-auth"), "[worker done] clanky:fix-auth run=run-1"),
	"[from watch:fix-auth] [worker done] clanky:fix-auth run=run-1",
	"wake is provenance-stamped by the watcher identity",
);

console.log("worker_watch smoke OK");
